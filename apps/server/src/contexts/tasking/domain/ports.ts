import type { Json } from '@agentforge/core';
import type { TaskSource, TaskSourceKind } from './task';

/** A task as seen at the source (GitHub issue, file line, Jira ticket). */
export interface ExternalTask {
  externalKey: string;
  title: string;
  body: string;
  meta: { [key: string]: Json };
  /** ISO creation time at the source, when the source knows it. */
  createdAt?: string;
}

export interface TaskSourceProviderContext {
  /** Decrypted project secrets (worker-side only). */
  env: Record<string, string>;
  projectRepoUrl: string;
  projectSettings: { [key: string]: Json | undefined };
  projectId: string;
}

export interface TaskSourceFetch {
  tasks: ExternalTask[];
  /** True when the fetch saw the source's complete current set — required
   *  before reconciliation may mark absent tasks as done. */
  complete: boolean;
}

/** Port: one per source kind; fetches the current external task list. */
export interface TaskSourceProvider {
  readonly kind: TaskSourceKind;
  fetch(source: TaskSource, ctx: TaskSourceProviderContext): Promise<TaskSourceFetch>;
}

export const TASK_SOURCE_PROVIDERS = Symbol('TaskSourceProviders');
