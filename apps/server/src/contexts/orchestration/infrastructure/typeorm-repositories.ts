import { Inject, Injectable } from '@nestjs/common';
import { In, type DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import { FlowRun, type FlowContext } from '../domain/flow-run';
import type { FlowStep, FlowStepDecision, FlowStepStatus } from '../domain/flow-step';
import type {
  FlowRunRepository,
  FlowStepRepository,
  ScheduleRepository,
  WorkflowRepository,
} from '../domain/repositories';
import type { Schedule, Workflow } from '../domain/workflow';
import { FlowRunEntity, FlowStepEntity, ScheduleEntity, WorkflowEntity } from './entities';

@Injectable()
export class TypeormWorkflowRepository implements WorkflowRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(workflow: Workflow): Promise<void> {
    await this.ds.getRepository(WorkflowEntity).insert({ ...workflow });
  }

  async findById(id: string): Promise<Workflow | null> {
    return this.ds.getRepository(WorkflowEntity).findOneBy({ id });
  }

  async listLatest(projectId: string): Promise<Workflow[]> {
    return this.ds
      .getRepository(WorkflowEntity)
      .createQueryBuilder('w')
      .distinctOn(['w.name'])
      .where('w.project_id = :projectId', { projectId })
      .orderBy('w.name', 'ASC')
      .addOrderBy('w.version', 'DESC')
      .getMany();
  }

  async findLatestByName(projectId: string, name: string): Promise<Workflow | null> {
    return this.ds
      .getRepository(WorkflowEntity)
      .createQueryBuilder('w')
      .where('w.project_id = :projectId AND w.name = :name', { projectId, name })
      .orderBy('w.version', 'DESC')
      .limit(1)
      .getOne();
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.ds.getRepository(WorkflowEntity).update({ id }, { enabled });
  }
}

@Injectable()
export class TypeormFlowRunRepository implements FlowRunRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(flowRun: FlowRun): Promise<void> {
    await this.ds.getRepository(FlowRunEntity).insert({ ...flowRun.snapshot() });
  }

  async save(flowRun: FlowRun): Promise<void> {
    await this.ds.getRepository(FlowRunEntity).update({ id: flowRun.id }, { ...flowRun.snapshot() });
  }

  async findById(id: string): Promise<FlowRun | null> {
    const entity = await this.ds.getRepository(FlowRunEntity).findOneBy({ id });
    return entity ? FlowRun.restore({ ...entity, context: entity.context as FlowContext }) : null;
  }

  async listActive(): Promise<FlowRun[]> {
    const rows = await this.ds
      .getRepository(FlowRunEntity)
      .findBy({ status: In(['running', 'awaiting_input']) });
    return rows.map((row) => FlowRun.restore({ ...row, context: row.context as FlowContext }));
  }

  async list(limit: number, cursor?: string): Promise<FlowRun[]> {
    const qb = this.ds
      .getRepository(FlowRunEntity)
      .createQueryBuilder('f')
      .orderBy('f.id', 'DESC')
      .limit(Math.min(limit, 200));
    if (cursor) qb.where('f.id < :cursor', { cursor });
    const rows = await qb.getMany();
    return rows.map((row) => FlowRun.restore({ ...row, context: row.context as FlowContext }));
  }
}

@Injectable()
export class TypeormFlowStepRepository implements FlowStepRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(step: FlowStep): Promise<void> {
    await this.ds.getRepository(FlowStepEntity).insert({ ...step });
  }

  async findById(id: string): Promise<FlowStep | null> {
    const entity = await this.ds.getRepository(FlowStepEntity).findOneBy({ id });
    return entity ? { ...entity } : null;
  }

  async findByRunId(runId: string): Promise<FlowStep | null> {
    const entity = await this.ds.getRepository(FlowStepEntity).findOneBy({ runId });
    return entity ? { ...entity } : null;
  }

  async listByFlowRun(flowRunId: string): Promise<FlowStep[]> {
    return this.ds
      .getRepository(FlowStepEntity)
      .find({ where: { flowRunId }, order: { startedAt: 'ASC', id: 'ASC' } });
  }

  async listActiveByFlowRun(flowRunId: string): Promise<FlowStep[]> {
    return this.ds
      .getRepository(FlowStepEntity)
      .findBy({ flowRunId, status: In(['running', 'awaiting_input']) });
  }

  async updateStatus(
    id: string,
    status: FlowStepStatus,
    opts: { decision?: FlowStepDecision; finishedAt?: Date } = {},
  ): Promise<void> {
    await this.ds.getRepository(FlowStepEntity).update(
      { id },
      {
        status,
        ...(opts.decision !== undefined ? { decision: opts.decision } : {}),
        ...(opts.finishedAt !== undefined ? { finishedAt: opts.finishedAt } : {}),
      },
    );
  }
}

@Injectable()
export class TypeormScheduleRepository implements ScheduleRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(schedule: Schedule): Promise<void> {
    await this.ds.getRepository(ScheduleEntity).insert({ ...schedule });
  }

  async save(schedule: Schedule): Promise<void> {
    await this.ds.getRepository(ScheduleEntity).update({ id: schedule.id }, { ...schedule });
  }

  async findById(id: string): Promise<Schedule | null> {
    return this.ds.getRepository(ScheduleEntity).findOneBy({ id });
  }

  async listEnabled(): Promise<Schedule[]> {
    return this.ds.getRepository(ScheduleEntity).findBy({ enabled: true });
  }

  async listByProject(projectId: string): Promise<Schedule[]> {
    return this.ds.getRepository(ScheduleEntity).findBy({ projectId });
  }

  async delete(id: string): Promise<void> {
    await this.ds.getRepository(ScheduleEntity).delete({ id });
  }
}
