import { Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { ExecutionWorkerModule } from './contexts/execution/execution-worker.module';
import { ProjectsModule } from './contexts/projects/projects.module';
import { ScmModule } from './contexts/scm/scm.module';
import { TaskingModule } from './contexts/tasking/tasking.module';
import { NotificationsModule } from './contexts/notifications/notifications.module';
import { OrchestrationModule } from './contexts/orchestration/orchestration.module';
import { DatabaseModule } from './database/database.module';
import { EnvModule } from './shared/env.module';
import { OutboxDispatcher } from './shared/outbox/outbox-dispatcher.service';
import { OutboxModule } from './shared/outbox/outbox.module';
import { QueueModule } from './shared/queue/queue.module';
import { RedisModule } from './shared/redis/redis.module';
import { WorkerHeartbeat } from './worker/heartbeat.service';
import { ProcessorsService } from './worker/processors.service';
import { ReconciliationService } from './worker/reconciliation.service';
import { SyncSchedulerService } from './worker/sync-scheduler.service';

@Injectable()
export class WorkerLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly reconciliation: ReconciliationService,
    private readonly heartbeat: WorkerHeartbeat,
    private readonly syncScheduler: SyncSchedulerService,
  ) {}

  onModuleInit(): void {
    this.dispatcher.start();
    this.reconciliation.start();
    this.heartbeat.start();
    this.syncScheduler.start();
  }

  onApplicationShutdown(): void {
    this.dispatcher.stop();
    this.reconciliation.stop();
    this.heartbeat.stop();
    this.syncScheduler.stop();
  }
}

@Module({
  imports: [
    EnvModule,
    DatabaseModule,
    RedisModule,
    QueueModule,
    OutboxModule,
    ExecutionWorkerModule,
    ScmModule,
    ProjectsModule,
    TaskingModule,
    NotificationsModule,
    OrchestrationModule,
  ],
  providers: [OutboxDispatcher, ReconciliationService, SyncSchedulerService, WorkerHeartbeat, WorkerLifecycle, ProcessorsService],
})
export class WorkerModule {}
