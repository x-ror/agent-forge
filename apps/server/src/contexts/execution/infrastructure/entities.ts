import { Column, Entity, PrimaryColumn } from 'typeorm';
import { bigintToNumber } from '../../../database/transformers';
import { RUN_STATUSES, type RunStatus } from '../domain/run';

@Entity('runs')
export class RunEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') projectId: string;
  @Column('uuid') agentId: string;
  @Column({ type: 'enum', enum: RUN_STATUSES, enumName: 'run_status' }) status: RunStatus;
  @Column('text') taskPrompt: string;
  @Column('text') baseRef: string;
  @Column('text', { nullable: true }) branch: string | null;
  @Column('jsonb') usage: unknown;
  @Column('text', { nullable: true }) error: string | null;
  @Column('timestamptz', { nullable: true }) leaseAt: Date | null;
  @Column('text', { nullable: true }) workspacePath: string | null;
  @Column('jsonb', { nullable: true }) resumeState: unknown;
  @Column('jsonb', { nullable: true }) structured: unknown;
  @Column('timestamptz') createdAt: Date;
  @Column('timestamptz', { nullable: true }) startedAt: Date | null;
  @Column('timestamptz', { nullable: true }) finishedAt: Date | null;
}

@Entity('run_events')
export class RunEventEntity {
  @PrimaryColumn('uuid') runId: string;
  @PrimaryColumn({ type: 'bigint', transformer: bigintToNumber }) seq: number;
  @Column('timestamptz') ts: Date;
  @Column('text') type: string;
  @Column('jsonb') payload: unknown;
}

@Entity('run_inputs')
export class RunInputEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') runId: string;
  @Column('uuid') userId: string;
  @Column('text') kind: string;
  @Column('jsonb') payload: unknown;
  @Column('timestamptz', { nullable: true }) consumedAt: Date | null;
  @Column('timestamptz') createdAt: Date;
}

@Entity('artifacts')
export class ArtifactEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid', { nullable: true }) runId: string | null;
  @Column('uuid', { nullable: true }) flowRunId: string | null;
  @Column('text') kind: string;
  @Column('text') name: string;
  @Column('bytea', { nullable: true }) content: Buffer | null;
  @Column('text', { nullable: true }) path: string | null;
  @Column('jsonb') meta: unknown;
  @Column('timestamptz') createdAt: Date;
}
