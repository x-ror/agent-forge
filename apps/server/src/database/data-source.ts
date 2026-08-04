import { DataSource } from 'typeorm';
import { AgentEntity } from '../contexts/agent-registry/infrastructure/entities';
import { PersonalAccessTokenEntity, SessionEntity, UserEntity } from '../contexts/identity/infrastructure/entities';
import { ArtifactEntity, RunEntity, RunEventEntity, RunInputEntity } from '../contexts/execution/infrastructure/entities';
import { FlowRunEntity, FlowStepEntity, ScheduleEntity, WorkflowEntity } from '../contexts/orchestration/infrastructure/entities';
import { ProjectEntity, SecretEntity } from '../contexts/projects/infrastructure/entities';
import { TaskEntity, TaskSourceEntity } from '../contexts/tasking/infrastructure/entities';
import { OutboxEventEntity } from '../shared/outbox/outbox-event.entity';
import { InitialSchema1754300000001 } from './migrations/1754300000001-initial-schema';
import { FlowEngine1754300000002 } from './migrations/1754300000002-flow-engine';
import { SnakeNamingStrategy } from './naming-strategy';

export const ALL_ENTITIES = [
  UserEntity,
  SessionEntity,
  PersonalAccessTokenEntity,
  ProjectEntity,
  SecretEntity,
  AgentEntity,
  TaskSourceEntity,
  TaskEntity,
  RunEntity,
  RunEventEntity,
  RunInputEntity,
  ArtifactEntity,
  WorkflowEntity,
  FlowRunEntity,
  FlowStepEntity,
  ScheduleEntity,
  OutboxEventEntity,
];

export const ALL_MIGRATIONS = [InitialSchema1754300000001, FlowEngine1754300000002];

/** Runtime connection — restricted app role. */
export function createAppDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    entities: ALL_ENTITIES,
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: false,
  });
}

/** Migration connection — owner role; the only place DDL happens. */
export function createAdminDataSource(url: string): DataSource {
  return new DataSource({
    type: 'postgres',
    url,
    migrations: ALL_MIGRATIONS,
    migrationsTableName: 'typeorm_migrations',
    namingStrategy: new SnakeNamingStrategy(),
    synchronize: false,
    logging: false,
  });
}
