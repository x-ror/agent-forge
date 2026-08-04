import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../shared/redis/redis.module';

export const WORKER_HEARTBEAT_KEY = 'agentforge:worker:heartbeat';

/** Health signal only — transient by design, lives in Redis, self-repopulates. */
@Injectable()
export class WorkerHeartbeat {
  private timer: NodeJS.Timeout | undefined;

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  start(intervalMs = 10_000): void {
    const beat = (): void => {
      void this.redis.set(WORKER_HEARTBEAT_KEY, new Date().toISOString()).catch(() => undefined);
    };
    beat();
    this.timer = setInterval(beat, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
