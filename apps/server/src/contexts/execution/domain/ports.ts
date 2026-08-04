import type { Json } from '@agentforge/core';
import type { IntegrationEvent } from '../../../shared/outbox/integration-event';
import type { Run } from './run';
import type { RunEvent, RunInput } from './run-event';

/**
 * Port: transactional persistence for the execution context. One tx for
 * run state + run_events + outbox rows (invariant #2). Implemented in
 * infrastructure (RunTxOps).
 */
export interface RunTxPort {
  insertRun(run: Run, integrationEvents: IntegrationEvent[]): Promise<void>;
  insertInput(input: RunInput, integrationEvents: IntegrationEvent[]): Promise<void>;
  saveRunAndEvents(
    run: Run,
    events: Array<{ type: string; payload: Json }>,
    integrationEvents?: IntegrationEvent[],
  ): Promise<RunEvent[]>;
  /** Which flow run (if any) owns this run — used to tick the engine. */
  flowRunIdFor(runId: string): Promise<string | null>;
}

export const RUN_TX = Symbol('RunTxPort');
