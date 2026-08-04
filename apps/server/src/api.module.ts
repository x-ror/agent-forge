import { Module } from '@nestjs/common';
import { AgentRegistryModule } from './contexts/agent-registry/agent-registry.module';
import { ExecutionModule } from './contexts/execution/execution.module';
import { TaskingModule } from './contexts/tasking/tasking.module';
import { OrchestrationModule } from './contexts/orchestration/orchestration.module';
import { IdentityModule } from './contexts/identity/identity.module';
import { ProjectsModule } from './contexts/projects/projects.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { EnvModule } from './shared/env.module';
import { OpenApiController } from './shared/openapi/openapi.controller';
import { OutboxModule } from './shared/outbox/outbox.module';
import { QueueModule } from './shared/queue/queue.module';
import { RedisModule } from './shared/redis/redis.module';

@Module({
  imports: [
    EnvModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    OutboxModule,
    IdentityModule,
    ProjectsModule,
    AgentRegistryModule,
    ExecutionModule,
    TaskingModule,
    OrchestrationModule,
  ],
  controllers: [HealthController, OpenApiController],
})
export class ApiModule {}
