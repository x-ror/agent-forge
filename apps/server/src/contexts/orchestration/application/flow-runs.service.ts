import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { EventTypes } from '../../../shared/outbox/integration-event';
import { uuidv7 } from '../../../shared/uuidv7';
import { ProjectsService } from '../../projects/application/projects.service';
import { TasksService } from '../../tasking/application/tasks.service';
import { FlowRun } from '../domain/flow-run';
import type { FlowStep } from '../domain/flow-step';
import { FLOW_RUN_REPOSITORY, FLOW_STEP_REPOSITORY, WORKFLOW_REPOSITORY, type FlowRunRepository, type FlowStepRepository, type WorkflowRepository } from '../domain/repositories';
import { ORCHESTRATION_TX, type OrchestrationTxPort } from '../domain/ports';

@Injectable()
export class FlowRunsService {
  constructor(
    @Inject(FLOW_RUN_REPOSITORY) private readonly flowRuns: FlowRunRepository,
    @Inject(FLOW_STEP_REPOSITORY) private readonly steps: FlowStepRepository,
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(ORCHESTRATION_TX) private readonly otx: OrchestrationTxPort,
    private readonly projects: ProjectsService,
    private readonly tasks: TasksService,
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

  async list(userId: string, limit: number, cursor?: string): Promise<FlowRun[]> {
    // v1: single-user self-host; list is filtered by ownership check per flow detail.
    void userId;
    return this.flowRuns.list(limit, cursor);
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
}
