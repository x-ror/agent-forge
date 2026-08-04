import type { Json } from '@agentforge/core';

export const FLOW_STATUSES = [
  'running',
  'awaiting_input',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type FlowStatus = (typeof FLOW_STATUSES)[number];

export const ACTIVE_FLOW_STATUSES: readonly FlowStatus[] = ['running', 'awaiting_input'];

/** §3.1: running ⇄ awaiting_input → succeeded | failed | cancelled */
const TRANSITIONS: Record<FlowStatus, readonly FlowStatus[]> = {
  running: ['awaiting_input', 'succeeded', 'failed', 'cancelled'],
  awaiting_input: ['running', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export class IllegalFlowTransitionError extends Error {
  constructor(
    public readonly from: FlowStatus,
    public readonly to: FlowStatus,
  ) {
    super(`illegal flow transition ${from} → ${to}`);
    this.name = 'IllegalFlowTransitionError';
  }
}

/** Accumulated node outputs + worktree ref; templated into agent prompts (§7.3). */
export type FlowContext = { [key: string]: Json };

export interface FlowRunProps {
  id: string;
  workflowId: string;
  taskId: string;
  status: FlowStatus;
  context: FlowContext;
  startedAt: Date;
  finishedAt: Date | null;
}

export class FlowRun {
  private constructor(private readonly props: FlowRunProps) {}

  static create(input: { id: string; workflowId: string; taskId: string }): FlowRun {
    return new FlowRun({
      ...input,
      status: 'running',
      context: {},
      startedAt: new Date(),
      finishedAt: null,
    });
  }

  static restore(props: FlowRunProps): FlowRun {
    return new FlowRun({ ...props });
  }

  get id(): string {
    return this.props.id;
  }
  get workflowId(): string {
    return this.props.workflowId;
  }
  get taskId(): string {
    return this.props.taskId;
  }
  get status(): FlowStatus {
    return this.props.status;
  }
  get context(): FlowContext {
    return this.props.context;
  }
  get startedAt(): Date {
    return this.props.startedAt;
  }
  get finishedAt(): Date | null {
    return this.props.finishedAt;
  }
  get isActive(): boolean {
    return ACTIVE_FLOW_STATUSES.includes(this.props.status);
  }

  snapshot(): FlowRunProps {
    return { ...this.props, context: { ...this.props.context } };
  }

  private transition(to: FlowStatus): void {
    if (!TRANSITIONS[this.props.status].includes(to)) {
      throw new IllegalFlowTransitionError(this.props.status, to);
    }
    this.props.status = to;
  }

  awaitInput(): void {
    this.transition('awaiting_input');
  }

  resume(): void {
    this.transition('running');
  }

  succeed(now = new Date()): void {
    this.transition('succeeded');
    this.props.finishedAt = now;
  }

  fail(now = new Date()): void {
    this.transition('failed');
    this.props.finishedAt = now;
  }

  cancel(now = new Date()): void {
    this.transition('cancelled');
    this.props.finishedAt = now;
  }

  mergeContext(patch: FlowContext): void {
    this.props.context = { ...this.props.context, ...patch };
  }
}
