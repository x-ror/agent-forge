import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CreateRunRequest, Json, RunInputRequest } from '@agentforge/core';
import { EventTypes } from '../../../shared/outbox/integration-event';
import { uuidv7 } from '../../../shared/uuidv7';
import { AGENT_REPOSITORY, type AgentRepository } from '../../agent-registry/domain/agent';
import { ProjectsService } from '../../projects/application/projects.service';
import { Run } from '../domain/run';
import type { RunEvent, RunInput } from '../domain/run-event';
import {
  RUN_EVENT_REPOSITORY,
  RUN_REPOSITORY,
  type RunEventRepository,
  type RunRepository,
} from '../domain/repositories';
import { RUN_TX, type RunTxPort } from '../domain/ports';

@Injectable()
export class RunsService {
  constructor(
    @Inject(RUN_REPOSITORY) private readonly runs: RunRepository,
    @Inject(RUN_EVENT_REPOSITORY) private readonly events: RunEventRepository,
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    @Inject(RUN_TX) private readonly tx: RunTxPort,
    private readonly projects: ProjectsService,
  ) {}

  async create(userId: string, req: CreateRunRequest): Promise<Run> {
    const project = await this.projects.getOwned(userId, req.projectId);
    const agent = await this.agents.findById(req.agentId);
    if (!agent || agent.ownerId !== userId) throw new BadRequestException('unknown agent');

    const run = Run.create({
      id: uuidv7(),
      projectId: project.id,
      agentId: agent.id,
      taskPrompt: req.prompt,
      baseRef: req.baseRef ?? project.defaultBranch,
    });
    // State + run.requested event commit atomically; the dispatcher enqueues.
    await this.tx.insertRun(run, [
      { aggregateType: 'run', aggregateId: run.id, eventType: EventTypes.RunRequested, payload: {} },
    ]);
    return run;
  }

  async getAccessible(userId: string, runId: string): Promise<Run> {
    const run = await this.runs.findById(runId);
    if (!run) throw new NotFoundException('run not found');
    try {
      await this.projects.getOwned(userId, run.projectId);
    } catch {
      throw new ForbiddenException('not your run');
    }
    return run;
  }

  async listEvents(userId: string, runId: string, afterSeq: number): Promise<RunEvent[]> {
    await this.getAccessible(userId, runId);
    return this.events.listAfter(runId, afterSeq, 1000);
  }

  async addInput(userId: string, runId: string, request: RunInputRequest): Promise<RunInput> {
    const run = await this.getAccessible(userId, runId);
    if (run.isTerminal) throw new BadRequestException('run already finished');

    const input: RunInput = {
      id: uuidv7(),
      runId,
      userId,
      kind: request.kind,
      payload: request as unknown as Json,
      consumedAt: null,
      createdAt: new Date(),
    };
    await this.tx.insertInput(input, [
      {
        aggregateType: 'run',
        aggregateId: runId,
        eventType: EventTypes.RunInputReceived,
        payload: { kind: request.kind },
      },
    ]);
    return input;
  }
}
