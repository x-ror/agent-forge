import type { Json } from '@agentforge/core';

/** One immutable row of the run's append-only event log (the system's spine). */
export interface RunEvent {
  runId: string;
  seq: number;
  ts: Date;
  type: string;
  payload: Json;
}

export interface RunInput {
  id: string;
  runId: string;
  userId: string;
  kind: 'message' | 'approval' | 'cancel';
  payload: Json;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface Artifact {
  id: string;
  runId: string;
  kind: 'diff' | 'pr' | 'file' | 'log-bundle' | 'patch';
  name: string;
  content: Buffer | null;
  path: string | null;
  meta: Json;
  createdAt: Date;
}
