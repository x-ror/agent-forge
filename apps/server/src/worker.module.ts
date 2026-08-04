import { Injectable, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { EnvModule } from './shared/env.module';

@Injectable()
export class WorkerHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;

  onModuleInit(): void {
    // Keeps the standalone application context alive; Phase 3 replaces this
    // with BullMQ processors + a Postgres-persisted heartbeat.
    this.timer = setInterval(() => undefined, 60_000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }
}

@Module({
  imports: [EnvModule],
  providers: [WorkerHeartbeatService],
})
export class WorkerModule {}
