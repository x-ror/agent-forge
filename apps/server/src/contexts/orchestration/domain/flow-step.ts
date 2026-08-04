export type FlowStepKind = 'trigger' | 'action' | 'agent' | 'decision' | 'gate';
export type FlowStepStatus = 'running' | 'awaiting_input' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface FlowStepDecision {
  route: string;
  reasoning: string;
}

export interface FlowStep {
  id: string;
  flowRunId: string;
  nodeId: string;
  kind: FlowStepKind;
  status: FlowStepStatus;
  runId: string | null;
  decision: FlowStepDecision | null;
  startedAt: Date;
  finishedAt: Date | null;
}
