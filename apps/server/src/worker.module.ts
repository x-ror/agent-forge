import { Injectable, Module, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { DatabaseModule } from './database/database.module';
import { EnvModule } from './shared/env.module';
import { OutboxDispatcher } from './shared/outbox/outbox-dispatcher.service';
import { OutboxModule } from './shared/outbox/outbox.module';
import { QueueModule } from './shared/queue/queue.module';
import { RedisModule } from './shared/redis/redis.module';
import { WorkerHeartbeat } from './worker/heartbeat.service';
import { ReconciliationService } from './worker/reconciliation.service';

@Injectable()
export class WorkerLifecycle implements OnModuleInit, OnApplicationShutdown {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly reconciliation: ReconciliationService,
    private readonly heartbeat: WorkerHeartbeat,
  ) {}

  onModuleInit(): void {
    this.dispatcher.start();
    this.reconciliation.start();
    this.heartbeat.start();
  }

  onApplicationShutdown(): void {
    this.dispatcher.stop();
    this.reconciliation.stop();
    this.heartbeat.stop();
  }
}

@Module({
  imports: [EnvModule, DatabaseModule, RedisModule, QueueModule, OutboxModule],
  providers: [OutboxDispatcher, ReconciliationService, WorkerHeartbeat, WorkerLifecycle],
})
export class WorkerModule {}
