import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  createWorkflowRequestSchema,
  gateDecisionRequestSchema,
  newWorkflowVersionRequestSchema,
  startFlowRequestSchema,
  type CreateWorkflowRequest,
  type FlowRunDto,
  type FlowStepDto,
  type GateDecisionRequest,
  type NewWorkflowVersionRequest,
  type StartFlowRequest,
  type WorkflowDto,
} from '@agentforge/core';
import { CurrentUser, type AuthUser } from '../../../shared/http/auth.decorators';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { PubSubListener } from '../../../shared/sse/pubsub-listener.service';
import { ARTIFACT_REPOSITORY, type ArtifactRepository } from '../../execution/domain/repositories';
import type { FlowRun } from '../domain/flow-run';
import type { FlowStep } from '../domain/flow-step';
import type { Workflow } from '../domain/workflow';
import { FlowRunsService } from '../application/flow-runs.service';
import { WorkflowsService } from '../application/workflows.service';

function workflowToDto(workflow: Workflow): WorkflowDto {
  return {
    id: workflow.id,
    projectId: workflow.projectId,
    name: workflow.name,
    version: workflow.version,
    definition: workflow.definition,
    enabled: workflow.enabled,
    createdAt: workflow.createdAt.toISOString(),
  };
}

function stepToDto(step: FlowStep): FlowStepDto {
  return {
    id: step.id,
    nodeId: step.nodeId,
    kind: step.kind,
    status: step.status,
    runId: step.runId,
    decision: step.decision,
    startedAt: step.startedAt.toISOString(),
    finishedAt: step.finishedAt?.toISOString() ?? null,
  };
}

function flowToDto(flowRun: FlowRun, steps?: FlowStep[]): FlowRunDto {
  return {
    id: flowRun.id,
    workflowId: flowRun.workflowId,
    taskId: flowRun.taskId,
    status: flowRun.status,
    context: flowRun.context as Record<string, unknown>,
    startedAt: flowRun.startedAt.toISOString(),
    finishedAt: flowRun.finishedAt?.toISOString() ?? null,
    ...(steps ? { steps: steps.map(stepToDto) } : {}),
  };
}

@Controller('workflows')
export class WorkflowsController {
  constructor(private readonly workflows: WorkflowsService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('projectId') projectId: string): Promise<WorkflowDto[]> {
    if (!projectId) throw new BadRequestException('projectId query param required');
    return (await this.workflows.listLatest(user.userId, projectId)).map(workflowToDto);
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(createWorkflowRequestSchema)) body: CreateWorkflowRequest): Promise<WorkflowDto> {
    return workflowToDto(await this.workflows.create(user.userId, body.projectId, body.name, body.definition));
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<WorkflowDto> {
    return workflowToDto(await this.workflows.getOwned(user.userId, id));
  }

  /** Edit = version n+1 (§7.3); the old version stays for pinned runs. */
  @Post(':id/versions')
  async newVersion(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(newWorkflowVersionRequestSchema)) body: NewWorkflowVersionRequest,
  ): Promise<WorkflowDto> {
    return workflowToDto(await this.workflows.newVersion(user.userId, id, body.definition));
  }

  @Patch(':id')
  async setEnabled(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() body: { enabled?: boolean }): Promise<{ ok: boolean }> {
    if (typeof body.enabled !== 'boolean') throw new BadRequestException('enabled: boolean required');
    await this.workflows.setEnabled(user.userId, id, body.enabled);
    return { ok: true };
  }
}

@Controller('flow-runs')
export class FlowRunsController {
  constructor(
    private readonly flowRuns: FlowRunsService,
    private readonly pubsub: PubSubListener,
    @Inject(ARTIFACT_REPOSITORY) private readonly artifacts: ArtifactRepository,
  ) {}

  @Post()
  async start(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(startFlowRequestSchema)) body: StartFlowRequest): Promise<FlowRunDto> {
    return flowToDto(await this.flowRuns.start(user.userId, body.workflowId, body.taskId));
  }

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('cursor') cursor?: string, @Query('limit') limit?: string): Promise<FlowRunDto[]> {
    const flows = await this.flowRuns.list(user.userId, limit ? Number(limit) : 50, cursor);
    return flows.map((f) => ({ ...flowToDto(f.flowRun), taskTitle: f.taskTitle, workflowName: f.workflowName, projectName: f.projectName }));
  }

  @Get(':id')
  async detail(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<FlowRunDto> {
    const { flowRun, steps } = await this.flowRuns.detail(user.userId, id);
    return flowToDto(flowRun, steps);
  }

  @Post(':id/gate')
  async gate(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodValidationPipe(gateDecisionRequestSchema)) body: GateDecisionRequest): Promise<{ ok: boolean }> {
    await this.flowRuns.resolveGate(user.userId, id, body.approve, body.note);
    return { ok: true };
  }

  /** Re-open a failed flow and re-tick from failed nodes (keeps succeeded steps / worktree). */
  @Post(':id/resume')
  async resume(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<FlowRunDto> {
    const flowRun = await this.flowRuns.resume(user.userId, id);
    const steps = (await this.flowRuns.detail(user.userId, id)).steps;
    return flowToDto(flowRun, steps);
  }

  /** Cancel session, delete worktree, return task to backlog (fresh Start workflow). */
  @Post(':id/abandon')
  async abandon(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<FlowRunDto> {
    const flowRun = await this.flowRuns.abandon(user.userId, id);
    const steps = (await this.flowRuns.detail(user.userId, id)).steps;
    return flowToDto(flowRun, steps);
  }

  /** Cumulative flow diff = latest diff artifact among the flow's runs (§9). */
  @Get(':id/diff')
  async diff(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ diff: string; baseRef: string | null }> {
    const { steps } = await this.flowRuns.detail(user.userId, id);
    for (const step of [...steps].reverse()) {
      if (!step.runId) continue;
      const artifacts = await this.artifacts.listByRun(step.runId);
      const diff = artifacts.filter((a) => a.kind === 'diff').at(-1);
      if (diff?.content) {
        return {
          diff: diff.content.toString('utf8'),
          baseRef: (diff.meta as { baseRef?: string }).baseRef ?? null,
        };
      }
    }
    throw new NotFoundException('no diff captured for this flow yet');
  }

  /** SSE: step transitions + status changes; clients refetch detail on wake. */
  @Get(':id/stream')
  async stream(@CurrentUser() user: AuthUser, @Param('id') id: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    await this.flowRuns.getAccessible(user.userId, id);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const unsubscribe = this.pubsub.onAggregate('flow_run', id, (message) => {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(`: hb\n\n`), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }
}
