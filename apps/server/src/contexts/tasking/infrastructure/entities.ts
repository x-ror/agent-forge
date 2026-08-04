import { Column, Entity, PrimaryColumn } from 'typeorm';
import { TASK_STATUSES, type TaskStatus } from '../domain/task';

@Entity('task_sources')
export class TaskSourceEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') projectId: string;
  @Column('text') kind: string;
  @Column('jsonb') config: unknown;
  @Column('text', { nullable: true }) syncCron: string | null;
  @Column('timestamptz', { nullable: true }) lastSyncedAt: Date | null;
}

@Entity('tasks')
export class TaskEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') projectId: string;
  @Column('uuid', { nullable: true }) sourceId: string | null;
  @Column('text', { nullable: true }) externalKey: string | null;
  @Column('text') title: string;
  @Column('text') body: string;
  @Column('text') status: TaskStatus;
  @Column('jsonb') meta: unknown;
  @Column('timestamptz') createdAt: Date;
  @Column('timestamptz') updatedAt: Date;
}

export { TASK_STATUSES };
