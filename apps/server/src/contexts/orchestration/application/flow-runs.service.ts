import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventTypes } from '../../../shared/outbox/integration-event';
import { uuidv7 } from '../../../shared/uuidv7';
import { ProjectsService } from '../../projects/application/projects.service';
import { ScmService } from '../../scm/application/scm.service';
import { TasksService } from '../../tasking/application/tasks.service';
import { FlowRun } from '../domain/flow-run';
import type { FlowStep } from '../domain/flow-step';
import {
  FLOW_RUN_REPOSITORY,
  FLOW_STEP_REPOSITORY,
  WORKFLOW_REPOSITORY,
  type FlowRunListItem,
  type FlowRunRepository,
  type FlowStepRepository,
  type WorkflowRepository,
} from '../domain/repositories';
import { ORCHESTRATION_TX, type OrchestrationTxPort } from '../domain/ports';

@Injectable()
export class FlowRunsService {
  private readonly logger = new Logger(FlowRunsService.name);

  constructor(
    @Inject(FLOW_RUN_REPOSITORY) private readonly flowRuns: FlowRunRepository,
    @Inject(FLOW_STEP_REPOSITORY) private readonly steps: FlowStepRepository,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(ORCHESTRATION_TX) private readonly otx: OrchestrationTxPort,
    private readonly projects: ProjectsService,
    private readonly tasks: TasksService,
    private readonly scm: ScmService,
  ) {}

  /**
   * Start (§2.5 step 2): one transaction inserts the flow run + the trigger
   * step, moves the task to in_flow, and emits flow.advance_requested.
   */
  async start(userId: string, workflowId: string, taskId: string): Promise<FlowRun> {
    const workflow = await this.workflows.findById(workflowId);
    if (!workflow) throw new NotFoundException('workflow not found');
    if (!workflow.enabled) throw new BadRequestException('workflow is disabled');
    await this.projects.getOwned(userId, workflow.projectId);

    const task = await this.tasks.getTask(userId, taskId);
    if (task.projectId !== workflow.projectId) {
      throw new BadRequestException('task and workflow belong to different projects');
    }
    if (task.status !== 'backlog') {
      throw new BadRequestException(`task is ${task.status}; only backlog tasks can start a flow`);
    }
    const trigger = workflow.definition.nodes.find((n) => n.type.startsWith('trigger.'));
    if (!trigger) throw new BadRequestException('workflow has no trigger node');

    const flowRun = FlowRun.create({ id: uuidv7(), workflowId, taskId });
    flowRun.mergeContext({
      task: {
        id: task.id,
        title: task.title,
        body: task.body,
        externalKey: task.externalKey,
        external_key: task.externalKey, // both spellings usable in templates
      },
    });

    await this.otx.startFlow({
      flowRun,
      triggerStep: {
        id: uuidv7(),
        flowRunId: flowRun.id,
        nodeId: trigger.id,
        kind: 'trigger',
        status: 'succeeded',
        runId: null,
        decision: null,
        startedAt: new Date(),
        finishedAt: new Date(),
      },
      taskId,
    });
    return flowRun;
  }

  async getAccessible(userId: string, flowRunId: string): Promise<FlowRun> {
    const flowRun = await this.flowRuns.findById(flowRunId);
    if (!flowRun) throw new NotFoundException('flow run not found');
    const workflow = await this.workflows.findById(flowRun.workflowId);
    if (!workflow) throw new NotFoundException('workflow not found');
    await this.projects.getOwned(userId, workflow.projectId);
    return flowRun;
  }

  async detail(userId: string, flowRunId: string): Promise<{ flowRun: FlowRun; steps: FlowStep[] }> {
    const flowRun = await this.getAccessible(userId, flowRunId);
    return { flowRun, steps: await this.steps.listByFlowRun(flowRunId) };
  }

  async list(userId: string, limit: number, cursor?: string, projectId?: string): Promise<FlowRunListItem[]> {
    const owned = await this.projects.list(userId);
    const ids = projectId ? owned.filter((p) => p.id === projectId).map((p) => p.id) : owned.map((p) => p.id);
    if (ids.length === 0) return [];
    return this.flowRuns.list(ids, limit, cursor);
  }

  /** gate.human resolution (§7.1): approve/reject → engine tick. */
  async resolveGate(userId: string, flowRunId: string, approve: boolean, note?: string): Promise<void> {
    await this.getAccessible(userId, flowRunId);
    const resolved = await this.otx.withFlowTick(flowRunId, async (ops) => {
      const state = ops.state();
      const gate = state.steps.find((s) => s.kind === 'gate' && s.status === 'awaiting_input');
      if (!gate) return false;
      await ops.completeStep(gate.id, 'succeeded', {
        decision: {
          route: approve ? 'approved' : 'rejected',
          reasoning: note ?? (approve ? 'approved by user' : 'rejected by user'),
        },
      });
      if (state.flow.status === 'awaiting_input') await ops.setFlowStatus('running');
      await ops.appendOutbox([
        {
          aggregateType: 'flow_run',
          aggregateId: flowRunId,
          eventType: approve ? EventTypes.GateApproved : EventTypes.GateRejected,
          payload: { note: note ?? null },
        },
      ]);
      return true;
    });
    if (!resolved) throw new BadRequestException('no gate awaiting approval on this flow');
  }

  /**
   * Manual single retry of a failed flow (no automatic agent re-runs).
   * Succeeded steps stay (e.g. worktree). Latest failed steps → skipped, then
   * one re-entry of those nodes. If they fail again the flow stops until the
   * user clicks Retry again.
   */
  async resume(userId: string, flowRunId: string): Promise<FlowRun> {
    await this.getAccessible(userId, flowRunId);
    const ok = await this.otx.withFlowTick(flowRunId, async (ops) => {
      const state = ops.state();
      if (state.flow.status !== 'failed') return false;

      // Supersede failed attempts so they no longer block re-entry or settle.
      const latestByNode = new Map<string, (typeof state.steps)[number]>();
      for (const step of state.steps) {
        const prev = latestByNode.get(step.nodeId);
        if (!prev || step.startedAt >= prev.startedAt) latestByNode.set(step.nodeId, step);
      }
      for (const step of latestByNode.values()) {
        if (step.status === 'failed') {
          await ops.completeStep(step.id, 'skipped', {
            decision: { route: 'resumed', reasoning: 'superseded by user resume' },
          });
        }
      }

      await ops.setFlowStatus('running', null);
      if (state.task.status === 'failed' || state.task.status === 'backlog') {
        await ops.setTaskStatus('in_flow');
      }
      await ops.appendOutbox([
        {
          aggregateType: 'flow_run',
          aggregateId: flowRunId,
          eventType: EventTypes.FlowAdvanceRequested,
          payload: { reason: 'resume_after_failure' },
        },
      ]);
      return true;
    });
    if (!ok) throw new BadRequestException('only failed flows can be resumed');
    const flow = await this.flowRuns.findById(flowRunId);
    if (!flow) throw new NotFoundException('flow run not found');
    return flow;
  }

  /**
   * Discard a flow session: cancel the flow, return the task to backlog, and
   * delete the flow worktree (+ local agentforge branch) so Start workflow can
   * run cleanly on the same issue again.
   */
  async abandon(userId: string, flowRunId: string): Promise<FlowRun> {
    await this.getAccessible(userId, flowRunId);

    const workspace = await this.otx.withFlowTick(flowRunId, async (ops) => {
      const state = ops.state();
      if (state.flow.status === 'succeeded') {
        throw new BadRequestException('cannot abandon a succeeded flow');
      }

      // Cancel any still-active steps so the timeline reflects discard.
      for (const step of state.steps) {
        if (step.status === 'running' || step.status === 'awaiting_input') {
          await ops.completeStep(step.id, 'cancelled', {
            decision: { route: 'abandoned', reasoning: 'session discarded by user' },
          });
        }
      }

      if (state.flow.status === 'running' || state.flow.status === 'awaiting_input' || state.flow.status === 'failed') {
        await ops.setFlowStatus('cancelled', new Date());
      }
      // already cancelled: still clean workspace + force task backlog below

      if (state.task.status === 'in_flow' || state.task.status === 'failed') {
        await ops.setTaskStatus('backlog');
      }

      await ops.appendOutbox([
        {
          aggregateType: 'flow_run',
          aggregateId: flowRunId,
          eventType: EventTypes.FlowStatusChanged,
          payload: { status: 'cancelled', reason: 'abandoned', taskId: state.task.id },
        },
      ]);

      const wt = state.flow.context.worktree as { path?: string; branch?: string } | undefined;
      return {
        projectId: state.projectId,
        branch: wt?.branch ?? null,
      };
    });

    if (!workspace) throw new NotFoundException('flow run not found');

    try {
      await this.scm.abandonFlowWorkspace(workspace.projectId, flowRunId, workspace.branch);
    } catch (error) {
      this.logger.warn(`abandon worktree cleanup for ${flowRunId}: ${String(error).slice(0, 300)}`);
    }

    const flow = await this.flowRuns.findById(flowRunId);
    if (!flow) throw new NotFoundException('flow run not found');
    return flow;
  }
}
