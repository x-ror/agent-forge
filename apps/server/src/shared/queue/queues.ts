import type { JobsOptions } from 'bullmq';

/** Queue topology (§5.2). Payloads are IDs only — Postgres is the truth. */
export const QUEUE_NAMES = [
  'flow.advance',
  'run.execute',
  'run.finalize',
  'task.sync',
  'repo.sync',
  'maintenance.cleanup',
  'notify.deliver',
] as const;

export type QueueName = (typeof QUEUE_NAMES)[number];

export interface QueuePayloads {
  'flow.advance': { flowRunId: string; event: string };
  'run.execute': { runId: string };
  'run.finalize': { runId: string };
  'task.sync': { taskSourceId: string };
  'repo.sync': { projectId: string };
  'maintenance.cleanup': Record<string, never>;
  'notify.deliver': { event: unknown; channel: string };
}

interface QueueConfig {
  /** Worker-side concurrency (§5.2); run.execute is overridden by env. */
  concurrency: number;
  defaultJobOptions: JobsOptions;
}

const RETRY_3X: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
};

const KEEP: JobsOptions = {
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

export const QUEUE_CONFIG: Record<QueueName, QueueConfig> = {
  'flow.advance': { concurrency: 5, defaultJobOptions: { ...KEEP, ...RETRY_3X } },
  // No blind re-runs: crashed runs recover via reconciliation (§5.2).
  'run.execute': { concurrency: 3, defaultJobOptions: { ...KEEP, attempts: 1 } },
  'run.finalize': { concurrency: 2, defaultJobOptions: { ...KEEP, ...RETRY_3X } },
  'task.sync': { concurrency: 2, defaultJobOptions: { ...KEEP, ...RETRY_3X } },
  'repo.sync': { concurrency: 2, defaultJobOptions: { ...KEEP, ...RETRY_3X } },
  'maintenance.cleanup': { concurrency: 1, defaultJobOptions: { ...KEEP, attempts: 1 } },
  'notify.deliver': {
    concurrency: 5,
    defaultJobOptions: { ...KEEP, attempts: 5, backoff: { type: 'exponential', delay: 5000 } },
  },
};
