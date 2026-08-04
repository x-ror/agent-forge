import type { Json } from '@agentforge/core';

/** Cross-process events persisted to outbox_events in the state-change tx (§2.4). */
export interface IntegrationEvent {
  aggregateType: 'run' | 'flow_run' | 'task' | 'task_source' | 'project' | 'notification';
  aggregateId: string;
  eventType: string;
  payload: Json;
}

export const EventTypes = {
  // Execution
  RunRequested: 'run.requested',
  RunEventAppended: 'run.event_appended',
  RunAwaitingInput: 'run.awaiting_input',
  RunSucceeded: 'run.succeeded',
  RunFailed: 'run.failed',
  RunCancelled: 'run.cancelled',
  RunFinalizeRequested: 'run.finalize_requested',
  RunInputReceived: 'run.input_received',
  // Orchestration
  FlowAdvanceRequested: 'flow.advance_requested',
  FlowStepChanged: 'flow.step_changed',
  FlowStatusChanged: 'flow.status_changed',
  DecisionMade: 'decision.made',
  GateApproved: 'gate.approved',
  GateRejected: 'gate.rejected',
  // Tasking / Scm
  TaskSyncRequested: 'task.sync_requested',
  TaskSynced: 'task.synced',
  TaskStatusChanged: 'task.status_changed',
  RepoSyncRequested: 'repo.sync_requested',
  // Notifications
  NotifyRequested: 'notify.requested',
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];

/** Single pub/sub channel; SSE endpoints filter by aggregate (§2.4). */
export const PUBSUB_CHANNEL = 'agentforge:events';

export interface PubSubMessage {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Json;
}
