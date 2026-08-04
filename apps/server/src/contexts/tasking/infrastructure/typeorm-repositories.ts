import { Inject, Injectable } from '@nestjs/common';
import { IsNull, Not, type DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import type { TaskRepository, TaskSourceRepository } from '../domain/repositories';
import type { Task, TaskSource, TaskSourceKind, TaskStatus } from '../domain/task';
import { TaskEntity, TaskSourceEntity } from './entities';

function sourceToDomain(entity: TaskSourceEntity): TaskSource {
  return { ...entity, kind: entity.kind as TaskSourceKind, config: entity.config as TaskSource['config'] };
}

function taskToDomain(entity: TaskEntity): Task {
  return { ...entity, meta: entity.meta as Task['meta'] };
}

@Injectable()
export class TypeormTaskSourceRepository implements TaskSourceRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(source: TaskSource): Promise<void> {
    await this.ds.getRepository(TaskSourceEntity).insert({ ...source });
  }

  async save(source: TaskSource): Promise<void> {
    await this.ds.getRepository(TaskSourceEntity).update({ id: source.id }, { ...source });
  }

  async findById(id: string): Promise<TaskSource | null> {
    const entity = await this.ds.getRepository(TaskSourceEntity).findOneBy({ id });
    return entity ? sourceToDomain(entity) : null;
  }

  async listByProject(projectId: string): Promise<TaskSource[]> {
    const rows = await this.ds.getRepository(TaskSourceEntity).find({ where: { projectId } });
    return rows.map(sourceToDomain);
  }

  async listWithCron(): Promise<TaskSource[]> {
    const rows = await this.ds
      .getRepository(TaskSourceEntity)
      .find({ where: { syncCron: Not(IsNull()) } });
    return rows.map(sourceToDomain);
  }

  async delete(id: string): Promise<void> {
    await this.ds.getRepository(TaskSourceEntity).delete({ id });
  }
}

@Injectable()
export class TypeormTaskRepository implements TaskRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(task: Task): Promise<void> {
    await this.ds.getRepository(TaskEntity).insert({ ...task });
  }

  async save(task: Task): Promise<void> {
    await this.ds.getRepository(TaskEntity).update({ id: task.id }, { ...task });
  }

  async findById(id: string): Promise<Task | null> {
    const entity = await this.ds.getRepository(TaskEntity).findOneBy({ id });
    return entity ? taskToDomain(entity) : null;
  }

  /**
   * Sync upsert on (source_id, external_key). Board lifecycle (status) is
   * owned locally, so re-sync refreshes content but never resets status.
   */
  async upsertSynced(
    task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'> & { id: string },
  ): Promise<string> {
    const rows: Array<{ id: string }> = await this.ds.query(
      `INSERT INTO tasks (id, project_id, source_id, external_key, title, body, status, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (source_id, external_key)
       DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body,
                     meta = EXCLUDED.meta, updated_at = now()
       RETURNING id`,
      [
        task.id,
        task.projectId,
        task.sourceId,
        task.externalKey,
        task.title,
        task.body,
        task.status,
        JSON.stringify(task.meta),
      ],
    );
    return rows[0]!.id;
  }

  async listBoard(
    projectId: string,
    opts: { status?: TaskStatus; cursor?: string; limit?: number } = {},
  ): Promise<Task[]> {
    const qb = this.ds
      .getRepository(TaskEntity)
      .createQueryBuilder('t')
      .where('t.project_id = :projectId', { projectId })
      .orderBy('t.id', 'DESC')
      .limit(Math.min(opts.limit ?? 50, 200));
    if (opts.status) qb.andWhere('t.status = :status', { status: opts.status });
    if (opts.cursor) qb.andWhere('t.id < :cursor', { cursor: opts.cursor });
    const rows = await qb.getMany();
    return rows.map(taskToDomain);
  }
}
