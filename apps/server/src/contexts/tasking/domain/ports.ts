import type { Json } from '@agentforge/core';
import type { TaskSource, TaskSourceKind } from './task';

/** A task as seen at the source (GitHub issue, file line, Jira ticket). */
export interface ExternalTask {
  externalKey: string;
  title: string;
  body: string;
  meta: { [key: string]: Json };
}

export interface TaskSourceProviderContext {
  /** Decrypted project secrets (worker-side only). */
  env: Record<string, string>;
  projectRepoUrl: string;
  projectSettings: { [key: string]: Json | undefined };
  projectId: string;
}

/** Port: one per source kind; fetches the current external task list. */
export interface TaskSourceProvider {
  readonly kind: TaskSourceKind;
  fetch(source: TaskSource, ctx: TaskSourceProviderContext): Promise<ExternalTask[]>;
}

export const TASK_SOURCE_PROVIDERS = Symbol('TaskSourceProviders');
