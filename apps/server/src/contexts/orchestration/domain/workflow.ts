import type { WorkflowDefinition } from '@agentforge/core';

/** Versioned, immutable-per-version workflow (edit = version n+1; runs pin a version). */
export interface Workflow {
  id: string;
  projectId: string;
  name: string;
  version: number;
  definition: WorkflowDefinition;
  enabled: boolean;
  createdAt: Date;
}

export interface Schedule {
  id: string;
  projectId: string;
  workflowId: string;
  name: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  catchUp: boolean;
  lastFiredAt: Date | null;
  createdAt: Date;
}
