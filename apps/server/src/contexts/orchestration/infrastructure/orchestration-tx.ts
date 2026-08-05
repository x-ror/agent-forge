import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { Json, WorkflowDefinition } from '@agentforge/core';
import { UnitOfWork } from '../../../database/unit-of-work';
import { toRow } from '../../../database/row';
import { OutboxWriter } from '../../../shared/outbox/outbox.writer';
import { EventTypes, type IntegrationEvent } from '../../../shared/outbox/integration-event';
import { RunEntity } from '../../execution/infrastructure/entities';
import { FlowRunEntity, FlowStepEntity } from './entities';
import type { FlowContext, FlowRunProps, FlowStatus } from '../domain/flow-run';
import type { FlowStep, FlowStepDecision, FlowStepStatus } from '../domain/flow-step';
import type { FlowRunAggregate, OrchestrationTxPort, RunInfo, TickOps, TickState } from '../domain/ports';

class EmTickOps implements TickOps {
  constructor(
    private readonly em: EntityManager,
    private readonly outbox: OutboxWriter,
    private readonly tickState: TickState,
  ) {}

  state(): TickState {
    return this.tickState;
  }

  async updateStepRun(stepId: string, runId: string | null): Promise<void> {
    await this.em.getRepository(FlowStepEntity).update({ id: stepId }, { runId });
    const step = this.tickState.steps.find((s) => s.id === stepId);
    if (step) step.runId = runId;
  }

  async completeStep(stepId: string, status: FlowStepStatus, opts: { decision?: FlowStepDecision } = {}): Promise<void> {
    await this.em.getRepository(FlowStepEntity).update(
      { id: stepId },
      {
        status,
        finishedAt: new Date(),
        ...(opts.decision !== undefined ? { decision: opts.decision } : {}),
      },
    );
    const step = this.tickState.steps.find((s) => s.id === stepId);
    if (step) {
      step.status = status;
      step.finishedAt = new Date();
      if (opts.decision !== undefined) step.decision = opts.decision;
    }
    await this.appendOutbox([
      {
        aggregateType: 'flow_run',
        aggregateId: this.tickState.flow.id,
        eventType: EventTypes.FlowStepChanged,
        payload: { stepId, nodeId: step?.nodeId ?? null, status },
      },
    ]);
  }

  async insertStep(step: FlowStep): Promise<void> {
    await this.em.getRepository(FlowStepEntity).insert({ ...step });
    this.tickState.steps.push(step);
    await this.appendOutbox([
      {
        aggregateType: 'flow_run',
        aggregateId: this.tickState.flow.id,
        eventType: EventTypes.FlowStepChanged,
        payload: { stepId: step.id, nodeId: step.nodeId, status: step.status },
      },
    ]);
  }

  async insertRun(args: {
    runId: string;
    agentId: string;
    prompt: string;
    baseRef: string;
    workspacePath: string | null;
    branch: string | null;
    structured: Json | null;
  }): Promise<void> {
    await this.em.getRepository(RunEntity).insert(
      toRow<RunEntity>({
        id: args.runId,
        projectId: this.tickState.projectId,
        agentId: args.agentId,
        status: 'queued',
        taskPrompt: args.prompt,
        baseRef: args.baseRef,
        branch: args.branch,
        usage: {},
        error: null,
        leaseAt: null,
        workspacePath: args.workspacePath,
        resumeState: null,
        structured: args.structured,
        createdAt: new Date(),
        startedAt: null,
        finishedAt: null,
      }),
    );
    await this.appendOutbox([
      {
        aggregateType: 'run',
        aggregateId: args.runId,
        eventType: EventTypes.RunRequested,
        payload: { flowRunId: this.tickState.flow.id },
      },
    ]);
  }

  async setFlowStatus(status: FlowStatus, finishedAt?: Date | null): Promise<void> {
    const patch: { status: FlowStatus; finishedAt?: Date | null } = { status };
    if (finishedAt !== undefined) patch.finishedAt = finishedAt;
    await this.em.getRepository(FlowRunEntity).update({ id: this.tickState.flow.id }, patch);
    this.tickState.flow.status = status;
    if (finishedAt !== undefined) this.tickState.flow.finishedAt = finishedAt;
    await this.appendOutbox([
      {
        aggregateType: 'flow_run',
        aggregateId: this.tickState.flow.id,
        eventType: EventTypes.FlowStatusChanged,
        payload: { status, taskId: this.tickState.task.id },
      },
    ]);
  }

  async mergeFlowContext(patch: FlowContext): Promise<void> {
    this.tickState.flow.context = deepMerge(this.tickState.flow.context, patch) as FlowContext;
    await this.em.getRepository(FlowRunEntity).update({ id: this.tickState.flow.id }, { context: this.tickState.flow.context });
  }

  async setTaskStatus(status: string): Promise<void> {
    await this.em.query(`UPDATE tasks SET status = $1, updated_at = now() WHERE id = $2`, [status, this.tickState.task.id]);
    this.tickState.task.status = status;
    await this.appendOutbox([
      {
        aggregateType: 'task',
        aggregateId: this.tickState.task.id,
        eventType: EventTypes.TaskStatusChanged,
        payload: { projectId: this.tickState.projectId, status },
      },
    ]);
  }

  async appendOutbox(events: IntegrationEvent[]): Promise<void> {
    await this.outbox.append(this.em, events);
  }

  async runInfo(runId: string): Promise<RunInfo | null> {
    const rows: Array<{ status: string; error: string | null; workspace_path: string | null }> = await this.em.query(
      `SELECT status, error, workspace_path FROM runs WHERE id = $1`,
      [runId],
    );
    const row = rows[0];
    return row ? { status: row.status, error: row.error, workspacePath: row.workspace_path } : null;
  }

  async lastRunResult(runId: string): Promise<{ summary: string; structured: Json | null } | null> {
    const rows: Array<{ payload: { summary?: string; structured?: Json } }> = await this.em.query(
      `SELECT payload FROM run_events WHERE run_id = $1 AND type = 'result' ORDER BY seq DESC LIMIT 1`,
      [runId],
    );
    const payload = rows[0]?.payload;
    return payload ? { summary: payload.summary ?? '', structured: payload.structured ?? null } : null;
  }

  async latestDiff(runId: string): Promise<string | null> {
    const rows: Array<{ content: Buffer | null }> = await this.em.query(`SELECT content FROM artifacts WHERE run_id = $1 AND kind = 'diff' ORDER BY created_at DESC LIMIT 1`, [
      runId,
    ]);
    return rows[0]?.content ? rows[0].content.toString('utf8') : null;
  }

  async agentIdByName(ownerId: string, name: string): Promise<string | null> {
    const rows: Array<{ id: string }> = await this.em.query(`SELECT id FROM agents WHERE owner_id = $1 AND name = $2`, [ownerId, name]);
    return rows[0]?.id ?? null;
  }
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (base === null || patch === null || typeof base !== 'object' || typeof patch !== 'object' || Array.isArray(base) || Array.isArray(patch)) {
    return patch;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    out[key] = key in out ? deepMerge(out[key], value) : value;
  }
  return out;
}

@Injectable()
export class OrchestrationTxOps implements OrchestrationTxPort {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxWriter,
  ) {}

  async startFlow(args: { flowRun: FlowRunAggregate; triggerStep: FlowStep; taskId: string }): Promise<void> {
    await this.uow.withTx(async (em) => {
      const snapshot = args.flowRun.snapshot();
      await em.getRepository(FlowRunEntity).insert({ ...snapshot });
      await em.getRepository(FlowStepEntity).insert({ ...args.triggerStep });
      await em.query(`UPDATE tasks SET status = 'in_flow', updated_at = now() WHERE id = $1`, [args.taskId]);
      const [taskRow]: Array<{ project_id: string }> = await em.query(`SELECT project_id FROM tasks WHERE id = $1`, [args.taskId]);
      await this.outbox.append(em, [
        {
          aggregateType: 'flow_run',
          aggregateId: snapshot.id,
          eventType: EventTypes.FlowAdvanceRequested,
          payload: { reason: 'flow_started' },
        },
        {
          aggregateType: 'task',
          aggregateId: args.taskId,
          eventType: EventTypes.TaskStatusChanged,
          payload: { projectId: taskRow?.project_id ?? null, status: 'in_flow' },
        },
      ]);
    });
  }

  async withFlowTick<T>(flowRunId: string, fn: (ops: TickOps) => Promise<T>): Promise<T | null> {
    return this.uow.withTx(async (em) => {
      // Serialize ticks per flow: concurrent flow.advance jobs queue up here.
      await em.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 42))`, [flowRunId]);

      const flowRows: Array<{
        id: string;
        workflow_id: string;
        task_id: string;
        status: string;
        context: FlowContext;
        started_at: Date;
        finished_at: Date | null;
      }> = await em.query(`SELECT * FROM flow_runs WHERE id = $1`, [flowRunId]);
      const flowRow = flowRows[0];
      if (!flowRow) return null;

      const [workflowRow]: Array<{ definition: WorkflowDefinition; project_id: string }> = await em.query(`SELECT definition, project_id FROM workflows WHERE id = $1`, [
        flowRow.workflow_id,
      ]);
      const [projectRow]: Array<{ owner_id: string; default_branch: string }> = await em.query(`SELECT owner_id, default_branch FROM projects WHERE id = $1`, [
        workflowRow!.project_id,
      ]);
      const [taskRow]: Array<{
        id: string;
        title: string;
        body: string;
        external_key: string | null;
        status: string;
      }> = await em.query(`SELECT id, title, body, external_key, status FROM tasks WHERE id = $1`, [flowRow.task_id]);
      const stepRows: Array<{
        id: string;
        flow_run_id: string;
        node_id: string;
        kind: string;
        status: string;
        run_id: string | null;
        decision: FlowStepDecision | null;
        started_at: Date;
        finished_at: Date | null;
      }> = await em.query(`SELECT * FROM flow_steps WHERE flow_run_id = $1 ORDER BY started_at, id`, [flowRunId]);

      const state: TickState = {
        flow: {
          id: flowRow.id,
          workflowId: flowRow.workflow_id,
          taskId: flowRow.task_id,
          status: flowRow.status as FlowRunProps['status'],
          context: flowRow.context,
          startedAt: flowRow.started_at,
          finishedAt: flowRow.finished_at,
        },
        definition: workflowRow!.definition,
        projectId: workflowRow!.project_id,
        projectOwnerId: projectRow!.owner_id,
        defaultBranch: projectRow!.default_branch,
        task: {
          id: taskRow!.id,
          title: taskRow!.title,
          body: taskRow!.body,
          externalKey: taskRow!.external_key,
          status: taskRow!.status,
        },
        steps: stepRows.map((row) => ({
          id: row.id,
          flowRunId: row.flow_run_id,
          nodeId: row.node_id,
          kind: row.kind as FlowStep['kind'],
          status: row.status as FlowStep['status'],
          runId: row.run_id,
          decision: row.decision,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
        })),
      };
      return fn(new EmTickOps(em, this.outbox, state));
    });
  }
}
