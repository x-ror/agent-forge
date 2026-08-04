import type { Json } from '@agentforge/core';

export const RUN_STATUSES = [
  'queued',
  'provisioning',
  'running',
  'awaiting_input',
  'finalizing',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const ACTIVE_RUN_STATUSES: readonly RunStatus[] = [
  'queued',
  'provisioning',
  'running',
  'awaiting_input',
  'finalizing',
];

/** §3.1: queued → provisioning → running ⇄ awaiting_input → finalizing → succeeded | failed | cancelled */
const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  queued: ['provisioning', 'cancelled', 'failed'],
  provisioning: ['running', 'failed', 'cancelled'],
  running: ['awaiting_input', 'finalizing', 'failed', 'cancelled'],
  awaiting_input: ['running', 'failed', 'cancelled'],
  finalizing: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class IllegalRunTransitionError extends Error {
  constructor(
    public readonly from: RunStatus,
    public readonly to: RunStatus,
  ) {
    super(`illegal run transition ${from} → ${to}`);
    this.name = 'IllegalRunTransitionError';
  }
}

export interface RunUsage {
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  wallTimeMs?: number;
  [key: string]: Json | undefined;
}

export interface RunProps {
  id: string;
  projectId: string;
  agentId: string;
  status: RunStatus;
  taskPrompt: string;
  baseRef: string;
  branch: string | null;
  usage: RunUsage;
  error: string | null;
  leaseAt: Date | null;
  workspacePath: string | null;
  resumeState: Json | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export class Run {
  private constructor(private readonly props: RunProps) {}

  static create(input: {
    id: string;
    projectId: string;
    agentId: string;
    taskPrompt: string;
    baseRef: string;
  }): Run {
    return new Run({
      ...input,
      status: 'queued',
      branch: null,
      usage: {},
      error: null,
      leaseAt: null,
      workspacePath: null,
      resumeState: null,
      createdAt: new Date(),
      startedAt: null,
      finishedAt: null,
    });
  }

  static restore(props: RunProps): Run {
    return new Run({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get projectId(): string {
    return this.props.projectId;
  }
  get agentId(): string {
    return this.props.agentId;
  }
  get status(): RunStatus {
    return this.props.status;
  }
  get taskPrompt(): string {
    return this.props.taskPrompt;
  }
  get baseRef(): string {
    return this.props.baseRef;
  }
  get branch(): string | null {
    return this.props.branch;
  }
  get usage(): RunUsage {
    return this.props.usage;
  }
  get error(): string | null {
    return this.props.error;
  }
  get leaseAt(): Date | null {
    return this.props.leaseAt;
  }
  get workspacePath(): string | null {
    return this.props.workspacePath;
  }
  get resumeState(): Json | null {
    return this.props.resumeState;
  }
  get createdAt(): Date {
    return this.props.createdAt;
  }
  get startedAt(): Date | null {
    return this.props.startedAt;
  }
  get finishedAt(): Date | null {
    return this.props.finishedAt;
  }

  get isActive(): boolean {
    return ACTIVE_RUN_STATUSES.includes(this.props.status);
  }
  get isTerminal(): boolean {
    return !this.isActive;
  }

  snapshot(): RunProps {
    return { ...this.props };
  }

  private transition(to: RunStatus): void {
    if (!TRANSITIONS[this.props.status].includes(to)) {
      throw new IllegalRunTransitionError(this.props.status, to);
    }
    this.props.status = to;
  }

  startProvisioning(now = new Date()): void {
    this.transition('provisioning');
    this.props.startedAt ??= now;
    this.props.leaseAt = now;
  }

  markRunning(): void {
    this.transition('running');
  }

  awaitInput(): void {
    this.transition('awaiting_input');
  }

  resumeRunning(): void {
    this.transition('running');
  }

  beginFinalizing(): void {
    this.transition('finalizing');
  }

  succeed(now = new Date()): void {
    this.transition('succeeded');
    this.props.finishedAt = now;
    this.props.leaseAt = null;
  }

  fail(error: string, now = new Date()): void {
    this.transition('failed');
    this.props.error = error;
    this.props.finishedAt = now;
    this.props.leaseAt = null;
  }

  cancel(now = new Date()): void {
    this.transition('cancelled');
    this.props.finishedAt = now;
    this.props.leaseAt = null;
  }

  heartbeat(now = new Date()): void {
    this.props.leaseAt = now;
  }

  setBranch(branch: string): void {
    this.props.branch = branch;
  }

  setWorkspacePath(path: string): void {
    this.props.workspacePath = path;
  }

  setResumeState(state: Json | null): void {
    this.props.resumeState = state;
  }

  mergeUsage(delta: RunUsage): void {
    const current = this.props.usage;
    this.props.usage = {
      ...current,
      ...delta,
      tokensIn: (current.tokensIn ?? 0) + (delta.tokensIn ?? 0),
      tokensOut: (current.tokensOut ?? 0) + (delta.tokensOut ?? 0),
      costUsd: (current.costUsd ?? 0) + (delta.costUsd ?? 0),
    };
  }
}
