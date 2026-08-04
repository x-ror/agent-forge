import { Column, Entity, PrimaryColumn } from 'typeorm';
import type { WorkflowDefinition } from '@agentforge/core';
import { FLOW_STATUSES, type FlowStatus } from '../domain/flow-run';
import type { FlowStepDecision, FlowStepKind, FlowStepStatus } from '../domain/flow-step';

@Entity('workflows')
export class WorkflowEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') projectId: string;
  @Column('text') name: string;
  @Column('int') version: number;
  @Column('jsonb') definition: WorkflowDefinition;
  @Column('boolean') enabled: boolean;
  @Column('timestamptz') createdAt: Date;
}

@Entity('flow_runs')
export class FlowRunEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') workflowId: string;
  @Column('uuid') taskId: string;
  @Column({ type: 'enum', enum: FLOW_STATUSES, enumName: 'flow_status' }) status: FlowStatus;
  @Column('jsonb') context: unknown;
  @Column('timestamptz') startedAt: Date;
  @Column('timestamptz', { nullable: true }) finishedAt: Date | null;
}

@Entity('flow_steps')
export class FlowStepEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') flowRunId: string;
  @Column('text') nodeId: string;
  @Column('text') kind: FlowStepKind;
  @Column('text') status: FlowStepStatus;
  @Column('uuid', { nullable: true }) runId: string | null;
  @Column('jsonb', { nullable: true }) decision: FlowStepDecision | null;
  @Column('timestamptz') startedAt: Date;
  @Column('timestamptz', { nullable: true }) finishedAt: Date | null;
}

@Entity('schedules')
export class ScheduleEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') projectId: string;
  @Column('uuid') workflowId: string;
  @Column('text') name: string;
  @Column('text') cron: string;
  @Column('text') timezone: string;
  @Column('boolean') enabled: boolean;
  @Column('boolean') catchUp: boolean;
  @Column('timestamptz', { nullable: true }) lastFiredAt: Date | null;
  @Column('timestamptz') createdAt: Date;
}
