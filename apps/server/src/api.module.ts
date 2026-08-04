import { Module } from '@nestjs/common';
import { ExecutionModule } from './contexts/execution/execution.module';
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
    ExecutionModule,
  ],
  controllers: [HealthController, OpenApiController],
})
export class ApiModule {}
