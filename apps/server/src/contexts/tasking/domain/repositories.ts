import type { Task, TaskSource, TaskStatus } from './task';

export interface TaskRepository {
  insert(task: Task): Promise<void>;
  save(task: Task): Promise<void>;
  findById(id: string): Promise<Task | null>;
  /** Sync upsert on (source_id, external_key); returns the task id. */
  /** sourceCreatedAt: creation time at the source (GitHub issue) — the board
   *  sorts newest-first by created_at, so source order survives the sync. */
  upsertSynced(task: Omit<Task, 'id' | 'createdAt' | 'updatedAt'> & { id: string; sourceCreatedAt?: Date }): Promise<string>;
  /** Close the loop: tasks of this source that vanished from the current
   *  external set (issue closed, checklist item removed/checked) move
   *  backlog/failed → done. Local in_flow/review/done are never touched. */
  markMissingAsDone(sourceId: string, presentExternalKeys: string[]): Promise<number>;
  /** Keyset-paginated board listing (cursor = last task id). */
  listBoard(projectId: string, opts?: { status?: TaskStatus; cursor?: string; limit?: number }): Promise<Task[]>;
}

export interface TaskSourceRepository {
  insert(source: TaskSource): Promise<void>;
  save(source: TaskSource): Promise<void>;
  findById(id: string): Promise<TaskSource | null>;
  listByProject(projectId: string): Promise<TaskSource[]>;
  listWithCron(): Promise<TaskSource[]>;
  delete(id: string): Promise<void>;
}

export const TASK_REPOSITORY = Symbol('TaskRepository');
export const TASK_SOURCE_REPOSITORY = Symbol('TaskSourceRepository');
