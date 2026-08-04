import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  createTaskRequestSchema,
  createTaskSourceRequestSchema,
  taskStatusSchema,
  updateTaskRequestSchema,
  type CreateTaskRequest,
  type CreateTaskSourceRequest,
  type TaskDto,
  type TaskSourceDto,
  type UpdateTaskRequest,
} from '@agentforge/core';
import { CurrentUser, type AuthUser } from '../../../shared/http/auth.decorators';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import { PubSubListener } from '../../../shared/sse/pubsub-listener.service';
import { ProjectsService } from '../../projects/application/projects.service';
import type { Task, TaskSource } from '../domain/task';
import { TasksService } from '../application/tasks.service';

function sourceToDto(source: TaskSource): TaskSourceDto {
  return {
    id: source.id,
    projectId: source.projectId,
    kind: source.kind,
    config: source.config as Record<string, unknown>,
    syncCron: source.syncCron,
    lastSyncedAt: source.lastSyncedAt?.toISOString() ?? null,
  };
}

function taskToDto(task: Task): TaskDto {
  return {
    id: task.id,
    projectId: task.projectId,
    sourceId: task.sourceId,
    externalKey: task.externalKey,
    title: task.title,
    body: task.body,
    status: task.status,
    meta: task.meta as Record<string, unknown>,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

@Controller('task-sources')
export class TaskSourcesController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('projectId') projectId: string,
  ): Promise<TaskSourceDto[]> {
    if (!projectId) throw new BadRequestException('projectId query param required');
    return (await this.tasks.listSources(user.userId, projectId)).map(sourceToDto);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTaskSourceRequestSchema)) body: CreateTaskSourceRequest,
  ): Promise<TaskSourceDto> {
    return sourceToDto(await this.tasks.createSource(user.userId, body));
  }

  @Post(':id/sync')
  @HttpCode(202)
  async sync(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ queued: boolean }> {
    await this.tasks.requestSync(user.userId, id);
    return { queued: true };
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.tasks.deleteSource(user.userId, id);
  }
}

@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly projects: ProjectsService,
    private readonly pubsub: PubSubListener,
  ) {}

  @Get()
  async board(
    @CurrentUser() user: AuthUser,
    @Query('projectId') projectId: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<{ tasks: TaskDto[]; nextCursor: string | null }> {
    if (!projectId) throw new BadRequestException('projectId query param required');
    const parsedStatus = status ? taskStatusSchema.parse(status) : undefined;
    const parsedLimit = limit ? Number(limit) : 50;
    const page = await this.tasks.board(user.userId, projectId, {
      status: parsedStatus,
      cursor,
      limit: parsedLimit,
    });
    return {
      tasks: page.map(taskToDto),
      nextCursor: page.length === parsedLimit ? (page.at(-1)?.id ?? null) : null,
    };
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createTaskRequestSchema)) body: CreateTaskRequest,
  ): Promise<TaskDto> {
    return taskToDto(await this.tasks.createTask(user.userId, body));
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<TaskDto> {
    return taskToDto(await this.tasks.getTask(user.userId, id));
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateTaskRequestSchema)) body: UpdateTaskRequest,
  ): Promise<TaskDto> {
    return taskToDto(await this.tasks.updateTask(user.userId, id, body));
  }

  /**
   * Board wake-up stream: task.synced / task.status_changed notifications for
   * one project. Stateless (no cursor) — clients refetch the board on wake-up.
   */
  @Get('stream/:projectId')
  async stream(
    @CurrentUser() user: AuthUser,
    @Param('projectId') projectId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    await this.projects.getOwned(user.userId, projectId);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const unsubscribe = this.pubsub.onAny((message) => {
      const payload = message.payload as { projectId?: string } | null;
      if (
        (message.eventType === 'task.synced' || message.eventType === 'task.status_changed') &&
        payload?.projectId === projectId
      ) {
        res.write(`data: ${JSON.stringify(message)}\n\n`);
      }
    });
    const heartbeat = setInterval(() => res.write(`: hb\n\n`), 25_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }
}
