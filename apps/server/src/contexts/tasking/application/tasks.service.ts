import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateTaskRequest, CreateTaskSourceRequest, Json, UpdateTaskRequest } from '@agentforge/core';
import { UnitOfWork } from '../../../database/unit-of-work';
import { OutboxWriter } from '../../../shared/outbox/outbox.writer';
import { EventTypes } from '../../../shared/outbox/integration-event';
import { uuidv7 } from '../../../shared/uuidv7';
import { ProjectsService } from '../../projects/application/projects.service';
import { assertTaskTransition, IllegalTaskTransitionError, type Task, type TaskSource, type TaskSourceKind, type TaskStatus } from '../domain/task';
import { TASK_REPOSITORY, TASK_SOURCE_REPOSITORY, type TaskRepository, type TaskSourceRepository } from '../domain/repositories';

@Injectable()
export class TasksService {
  constructor(
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    @Inject(TASK_SOURCE_REPOSITORY) private readonly sources: TaskSourceRepository,
    private readonly projects: ProjectsService,
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxWriter,
  ) {}

  // ---- sources -------------------------------------------------------------

  async createSource(userId: string, input: CreateTaskSourceRequest): Promise<TaskSource> {
    await this.projects.getOwned(userId, input.projectId);
    const source: TaskSource = {
      id: uuidv7(),
      projectId: input.projectId,
      kind: input.kind as TaskSourceKind,
      config: input.config as { [key: string]: Json },
      syncCron: input.syncCron ?? null,
      lastSyncedAt: null,
    };
    await this.sources.insert(source);
    return source;
  }

  async listSources(userId: string, projectId: string): Promise<TaskSource[]> {
    await this.projects.getOwned(userId, projectId);
    return this.sources.listByProject(projectId);
  }

  async deleteSource(userId: string, sourceId: string): Promise<void> {
    const source = await this.sources.findById(sourceId);
    if (!source) throw new NotFoundException('task source not found');
    await this.projects.getOwned(userId, source.projectId);
    await this.sources.delete(sourceId);
  }

  /** Manual sync: emits task.sync_requested; the dispatcher enqueues the job. */
  async requestSync(userId: string, sourceId: string): Promise<void> {
    const source = await this.sources.findById(sourceId);
    if (!source) throw new NotFoundException('task source not found');
    await this.projects.getOwned(userId, source.projectId);
    await this.uow.withTx((em) =>
      this.outbox.append(em, [
        {
          aggregateType: 'task_source',
          aggregateId: sourceId,
          eventType: EventTypes.TaskSyncRequested,
          payload: { projectId: source.projectId },
        },
      ]),
    );
  }

  // ---- tasks ---------------------------------------------------------------

  async createTask(userId: string, input: CreateTaskRequest): Promise<Task> {
    await this.projects.getOwned(userId, input.projectId);
    const task: Task = {
      id: uuidv7(),
      projectId: input.projectId,
      sourceId: null,
      externalKey: null,
      title: input.title,
      body: input.body,
      status: 'backlog',
      meta: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await this.tasks.insert(task);
    return task;
  }

  async board(userId: string, projectId: string, opts: { status?: TaskStatus; cursor?: string; limit?: number }): Promise<Task[]> {
    await this.projects.getOwned(userId, projectId);
    return this.tasks.listBoard(projectId, opts);
  }

  async getTask(userId: string, taskId: string): Promise<Task> {
    const task = await this.tasks.findById(taskId);
    if (!task) throw new NotFoundException('task not found');
    await this.projects.getOwned(userId, task.projectId);
    return task;
  }

  async updateTask(userId: string, taskId: string, input: UpdateTaskRequest): Promise<Task> {
    const task = await this.getTask(userId, taskId);
    if (input.status && input.status !== task.status) {
      try {
        assertTaskTransition(task.status, input.status);
      } catch (error) {
        if (error instanceof IllegalTaskTransitionError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
      task.status = input.status;
    }
    task.title = input.title ?? task.title;
    task.body = input.body ?? task.body;
    task.updatedAt = new Date();
    await this.tasks.save(task);
    if (input.status) {
      await this.uow.withTx((em) =>
        this.outbox.append(em, [
          {
            aggregateType: 'task',
            aggregateId: task.id,
            eventType: EventTypes.TaskStatusChanged,
            payload: { projectId: task.projectId, status: task.status },
          },
        ]),
      );
    }
    return task;
  }
}
