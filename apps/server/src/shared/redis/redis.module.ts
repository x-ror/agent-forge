import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import { APP_ENV, type AppEnv } from '../../config/env';

export const REDIS = Symbol('REDIS');

export function createRedis(url: string): Redis {
  return new IORedis(url, { maxRetriesPerRequest: null, lazyConnect: false });
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [APP_ENV],
      useFactory: (env: AppEnv): Redis => createRedis(env.REDIS_URL),
    },
  ],
  exports: [REDIS],
})
export class RedisModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
