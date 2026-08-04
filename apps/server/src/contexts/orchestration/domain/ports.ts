import type { Json, WorkflowDefinition } from '@agentforge/core';
import type { IntegrationEvent } from '../../../shared/outbox/integration-event';
import type { FlowContext, FlowRunProps, FlowStatus } from './flow-run';
import type { FlowStep, FlowStepDecision, FlowStepStatus } from './flow-step';

export interface TickState {
  flow: FlowRunProps;
  definition: WorkflowDefinition;
  projectId: string;
  projectOwnerId: string;
  defaultBranch: string;
  task: { id: string; title: string; body: string; externalKey: string | null; status: string };
  steps: FlowStep[];
}

export interface RunInfo {
  status: string;
  error: string | null;
  workspacePath: string | null;
}

/**
 * Port: everything one engine tick may do, executed inside ONE transaction
 * holding a per-flow advisory lock (ticks for the same flow serialize).
 */
export interface TickOps {
  state(): TickState;
  completeStep(stepId: string, status: FlowStepStatus, opts?: { decision?: FlowStepDecision }): Promise<void>;
  insertStep(step: FlowStep): Promise<void>;
  /** Create the run backing an agent/decision step (+ run.requested outbox). */
  insertRun(args: { runId: string; agentId: string; prompt: string; baseRef: string; workspacePath: string | null; branch: string | null; structured: Json | null }): Promise<void>;
  setFlowStatus(status: FlowStatus, finishedAt?: Date): Promise<void>;
  mergeFlowContext(patch: FlowContext): Promise<void>;
  setTaskStatus(status: string): Promise<void>;
  appendOutbox(events: IntegrationEvent[]): Promise<void>;
  runInfo(runId: string): Promise<RunInfo | null>;
  /** Latest 'result' protocol event of a run (summary + structured). */
  lastRunResult(runId: string): Promise<{ summary: string; structured: Json | null } | null>;
  /** Latest diff artifact content of a run. */
  latestDiff(runId: string): Promise<string | null>;
  agentIdByName(ownerId: string, name: string): Promise<string | null>;
}

export interface OrchestrationTxPort {
  /** Runs `fn` inside a tx holding the flow's advisory lock; null if flow missing. */
  withFlowTick<T>(flowRunId: string, fn: (ops: TickOps) => Promise<T>): Promise<T | null>;
}

export const ORCHESTRATION_TX = Symbol('OrchestrationTxPort');
