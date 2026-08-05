import type { Artifact, RunEvent, RunInput } from './run-event';
import type { Run } from './run';

export interface RunRepository {
  insert(run: Run): Promise<void>;
  save(run: Run): Promise<void>;
  findById(id: string): Promise<Run | null>;
  /** Active runs whose lease_at is older than the given cutoff (§5.4 recovery). */
  findStaleActive(cutoff: Date): Promise<Run[]>;
  /** Per-day usage/cost aggregates for a project's runs (newest day first). */
  usageSummary(projectId: string, days: number): Promise<UsageDay[]>;
}

export interface UsageDay {
  day: string;
  runs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

export interface RunEventRepository {
  /** Append with per-run monotonic seq; returns the events with assigned seq. */
  append(runId: string, events: Array<{ type: string; payload: RunEvent['payload'] }>): Promise<RunEvent[]>;
  listAfter(runId: string, afterSeq: number, limit?: number): Promise<RunEvent[]>;
  lastSeq(runId: string): Promise<number>;
}

export interface RunInputRepository {
  insert(input: RunInput): Promise<void>;
  /** Oldest unconsumed inputs for a run. */
  pending(runId: string): Promise<RunInput[]>;
  markConsumed(id: string, at?: Date): Promise<void>;
}

export interface ArtifactRepository {
  insert(artifact: Artifact): Promise<void>;
  findById(id: string): Promise<Artifact | null>;
  listByRun(runId: string): Promise<Artifact[]>;
}

export const RUN_REPOSITORY = Symbol('RunRepository');
export const RUN_EVENT_REPOSITORY = Symbol('RunEventRepository');
export const RUN_INPUT_REPOSITORY = Symbol('RunInputRepository');
export const ARTIFACT_REPOSITORY = Symbol('ArtifactRepository');
