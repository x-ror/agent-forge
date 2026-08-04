import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS, RedisModule } from '../redis/redis.module';
import { QUEUE_CONFIG, QUEUE_NAMES, type QueueName, type QueuePayloads } from './queues';

export const QUEUES = Symbol('QUEUES');

export type QueueMap = { [K in QueueName]: Queue<QueuePayloads[K]> };

@Global()
@Module({
  imports: [RedisModule],
  providers: [
    {
      provide: QUEUES,
      inject: [REDIS],
      useFactory: (redis: Redis): QueueMap => {
        const map = {} as Record<QueueName, Queue>;
        for (const name of QUEUE_NAMES) {
          map[name] = new Queue(name, {
            connection: redis,
            defaultJobOptions: QUEUE_CONFIG[name].defaultJobOptions,
          });
        }
        return map as QueueMap;
      },
    },
  ],
  exports: [QUEUES],
})
export class QueueModule implements OnApplicationShutdown {
  constructor(@Inject(QUEUES) private readonly queues: QueueMap) {}

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(Object.values(this.queues).map((queue) => queue.close()));
  }
}
