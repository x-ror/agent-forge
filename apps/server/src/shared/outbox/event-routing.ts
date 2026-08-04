import type { Json } from '@agentforge/core';
import type { QueueName, QueuePayloads } from '../queue/queues';
import { EventTypes } from './integration-event';

export interface OutboxRow {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  payload: Json;
}

export interface JobSpec<K extends QueueName = QueueName> {
  queue: K;
  data: QueuePayloads[K];
  /** Deterministic — duplicate dispatch of the same outbox row is a no-op. */
  jobId: string;
}

function flowAdvance(row: OutboxRow, flowRunId: string): JobSpec<'flow.advance'> {
  return {
    queue: 'flow.advance',
    data: { flowRunId, event: row.event_type },
    jobId: `flow.advance__${flowRunId}__${row.id}`,
  };
}

/**
 * Translates a committed outbox row into its BullMQ effect(s).
 * Every row is additionally published on Redis pub/sub for SSE wake-ups.
 */
export function routeIntegrationEvent(row: OutboxRow): JobSpec[] {
  const payload = (row.payload ?? {}) as { flowRunId?: string; channel?: string };
  const jobs: JobSpec[] = [];

  switch (row.event_type) {
    case EventTypes.RunRequested:
      jobs.push({
        queue: 'run.execute',
        data: { runId: row.aggregate_id },
        jobId: `run.execute__${row.aggregate_id}`,
      });
      break;

    case EventTypes.RunFinalizeRequested:
      jobs.push({
        queue: 'run.finalize',
        data: { runId: row.aggregate_id },
        jobId: `run.finalize__${row.aggregate_id}__${row.id}`,
      });
      break;

    case EventTypes.RunSucceeded:
    case EventTypes.RunFailed:
    case EventTypes.RunCancelled:
      // Runs that belong to a flow step tick the engine forward.
      if (payload.flowRunId) jobs.push(flowAdvance(row, payload.flowRunId));
      break;

    case EventTypes.FlowAdvanceRequested:
    case EventTypes.GateApproved:
    case EventTypes.GateRejected:
    case EventTypes.DecisionMade:
      jobs.push(flowAdvance(row, row.aggregate_id));
      break;

    case EventTypes.TaskSyncRequested:
      jobs.push({
        queue: 'task.sync',
        data: { taskSourceId: row.aggregate_id },
        jobId: `task.sync__${row.aggregate_id}__${row.id}`,
      });
      break;

    case EventTypes.RepoSyncRequested:
      jobs.push({
        queue: 'repo.sync',
        data: { projectId: row.aggregate_id },
        jobId: `repo.sync__${row.aggregate_id}__${row.id}`,
      });
      break;

    case EventTypes.NotifyRequested:
      jobs.push({
        queue: 'notify.deliver',
        data: { event: row.payload, channel: payload.channel ?? 'log' },
        jobId: `notify.deliver__${row.id}`,
      });
      break;

    default:
      // Pure notification events (run.event_appended, task.synced, …):
      // pub/sub only, no job.
      break;
  }

  return jobs;
}
