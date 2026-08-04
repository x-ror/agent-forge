import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import IORedis, { type Redis } from 'ioredis';

export interface RedisTestContext {
  container: StartedRedisContainer;
  url: string;
  client: Redis;
  stop(): Promise<void>;
}

export async function startRedis(): Promise<RedisTestContext> {
  const container = await new RedisContainer('redis:7-alpine').start();
  const url = container.getConnectionUrl();
  const client = new IORedis(url, { maxRetriesPerRequest: null });
  return {
    container,
    url,
    client,
    stop: async () => {
      await client.quit().catch(() => client.disconnect());
      await container.stop();
    },
  };
}
