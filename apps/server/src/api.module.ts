import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { AgentRegistryModule } from './contexts/agent-registry/agent-registry.module';
import { ExecutionModule } from './contexts/execution/execution.module';
import { TaskingModule } from './contexts/tasking/tasking.module';
import { OrchestrationModule } from './contexts/orchestration/orchestration.module';
import { IdentityModule } from './contexts/identity/identity.module';
import { ProjectsModule } from './contexts/projects/projects.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { EnvModule } from './shared/env.module';
import { MetricsController } from './shared/metrics/metrics.controller';
import { OpenApiController } from './shared/openapi/openapi.controller';
import { OutboxModule } from './shared/outbox/outbox.module';
import { QueueModule } from './shared/queue/queue.module';
import { RedisModule } from './shared/redis/redis.module';

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? 'info',
        redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        autoLogging: { ignore: (req) => req.url?.includes('/events/stream') ?? false },
      },
    }),
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
  controllers: [HealthController, OpenApiController, MetricsController],
})
export class ApiModule {}
