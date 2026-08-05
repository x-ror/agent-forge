import type { Json } from '@agentforge/core';

export const TASK_STATUSES = ['backlog', 'in_flow', 'done', 'failed', 'archived'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** §3.1: backlog → in_flow → done | failed → archived (+ failed → backlog | in_flow resume; done → backlog reopen). */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  backlog: ['in_flow', 'archived'],
  in_flow: ['done', 'failed', 'backlog'],
  done: ['archived', 'backlog'], // reopen: re-run a task with a newer workflow, or the source issue reopened
  failed: ['archived', 'backlog', 'in_flow'], // in_flow = resume same flow after failure
  archived: [],
};

export class IllegalTaskTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`illegal task transition ${from} → ${to}`);
    this.name = 'IllegalTaskTransitionError';
  }
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new IllegalTaskTransitionError(from, to);
}

export interface Task {
  id: string;
  projectId: string;
  sourceId: string | null;
  externalKey: string | null;
  title: string;
  body: string;
  status: TaskStatus;
  meta: { [key: string]: Json };
  createdAt: Date;
  updatedAt: Date;
}

export type TaskSourceKind = 'github_issues' | 'jira' | 'file' | 'manual';

export interface TaskSource {
  id: string;
  projectId: string;
  kind: TaskSourceKind;
  config: { [key: string]: Json };
  syncCron: string | null;
  lastSyncedAt: Date | null;
}
