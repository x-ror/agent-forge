import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  createRunRequestSchema,
  runInputRequestSchema,
  type CreateRunRequest,
  type RunDto,
  type RunEventDto,
  type RunInputRequest,
} from '@agentforge/core';
import { CurrentUser, type AuthUser } from '../../../shared/http/auth.decorators';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { PubSubListener } from '../../../shared/sse/pubsub-listener.service';
import type { Run } from '../domain/run';
import type { RunEvent } from '../domain/run-event';
import { RUN_EVENT_REPOSITORY, type RunEventRepository } from '../domain/repositories';
import { RunsService } from '../application/runs.service';

import { NotFoundException } from '@nestjs/common';
import { ARTIFACT_REPOSITORY, type ArtifactRepository } from '../domain/repositories';

const SSE_HEARTBEAT_MS = 25_000;

function toDto(run: Run): RunDto {
  return {
    id: run.id,
    projectId: run.projectId,
    agentId: run.agentId,
    status: run.status,
    taskPrompt: run.taskPrompt,
    baseRef: run.baseRef,
    branch: run.branch,
    usage: run.usage as Record<string, unknown>,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}

function toEventDto(event: RunEvent): RunEventDto {
  return {
    runId: event.runId,
    seq: event.seq,
    ts: event.ts.toISOString(),
    type: event.type,
    payload: event.payload,
  };
}

@Controller('runs')
export class RunsController {
  constructor(
    private readonly runs: RunsService,
    private readonly pubsub: PubSubListener,
    @Inject(RUN_EVENT_REPOSITORY) private readonly events: RunEventRepository,
    @Inject(ARTIFACT_REPOSITORY) private readonly artifacts: ArtifactRepository,
  ) {}

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createRunRequestSchema)) body: CreateRunRequest,
  ): Promise<RunDto> {
    return toDto(await this.runs.create(user.userId, body));
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<RunDto> {
    return toDto(await this.runs.getAccessible(user.userId, id));
  }

  @Get(':id/events')
  async list(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Query('after_seq') afterSeq?: string,
  ): Promise<RunEventDto[]> {
    const events = await this.runs.listEvents(user.userId, id, Number(afterSeq ?? 0));
    return events.map(toEventDto);
  }

  /** Cumulative diff — served from the finalize-time artifact (api has no workspaces volume). */
  @Get(':id/diff')
  async diff(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<{ diff: string; baseRef: string | null }> {
    await this.runs.getAccessible(user.userId, id);
    const artifacts = await this.artifacts.listByRun(id);
    const diff = artifacts.filter((a) => a.kind === 'diff').at(-1);
    if (!diff?.content) throw new NotFoundException('no diff captured for this run');
    const baseRef = (diff.meta as { baseRef?: string }).baseRef ?? null;
    return { diff: diff.content.toString('utf8'), baseRef };
  }

  @Get(':id/artifacts')
  async listArtifacts(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
  ): Promise<Array<{ id: string; kind: string; name: string; meta: unknown }>> {
    await this.runs.getAccessible(user.userId, id);
    const artifacts = await this.artifacts.listByRun(id);
    return artifacts.map((a) => ({ id: a.id, kind: a.kind, name: a.name, meta: a.meta }));
  }

  @Post(':id/inputs')
  async addInput(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(runInputRequestSchema)) body: RunInputRequest,
  ): Promise<{ id: string }> {
    const input = await this.runs.addInput(user.userId, id, body);
    return { id: input.id };
  }

  /**
   * SSE live stream (§9): durable cursor = run_events.seq, `Last-Event-ID`
   * resume, Redis pub/sub as wake-up, 25s heartbeat. Lossless across client
   * AND Redis restarts because every drain reads from Postgres.
   */
  @Get(':id/events/stream')
  async stream(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.runs.getAccessible(user.userId, id);

    const lastEventId = req.headers['last-event-id'];
    const afterSeq = Number(
      (Array.isArray(lastEventId) ? lastEventId[0] : lastEventId) ??
        (req.query.after_seq as string | undefined) ??
        0,
    );

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let cursor = Number.isFinite(afterSeq) ? afterSeq : 0;
    let draining = false;
    let pendingDrain = false;
    let closed = false;

    const drain = async (): Promise<void> => {
      if (draining) {
        pendingDrain = true;
        return;
      }
      draining = true;
      try {
        // Loop until no new rows so bursts and wake-up coalescing can't skip.
        for (;;) {
          const batch = await this.events.listAfter(id, cursor, 500);
          if (closed || batch.length === 0) break;
          for (const event of batch) {
            cursor = event.seq;
            res.write(`id: ${event.seq}\ndata: ${JSON.stringify(toEventDto(event))}\n\n`);
          }
        }
      } finally {
        draining = false;
        if (pendingDrain && !closed) {
          pendingDrain = false;
          void drain();
        }
      }
    };

    await drain();
    const unsubscribe = this.pubsub.onAggregate('run', id, () => void drain());
    const heartbeat = setInterval(() => {
      if (!closed) res.write(`: hb\n\n`);
    }, SSE_HEARTBEAT_MS);

    req.on('close', () => {
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }
}
