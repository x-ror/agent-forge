import { EventEmitter } from 'node:events';
import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS } from '../redis/redis.module';
import { PUBSUB_CHANNEL, type PubSubMessage } from '../outbox/integration-event';

/**
 * One Redis subscription per api process, fanned out to SSE handlers.
 * Pub/sub is only a wake-up signal — the durable cursor lives in Postgres.
 */
@Injectable()
export class PubSubListener implements OnModuleInit, OnApplicationShutdown {
  private readonly emitter = new EventEmitter();
  private subscriber: Redis | undefined;

  constructor(@Inject(REDIS) private readonly redis: Redis) {
    this.emitter.setMaxListeners(0);
  }

  async onModuleInit(): Promise<void> {
    this.subscriber = this.redis.duplicate();
    await this.subscriber.subscribe(PUBSUB_CHANNEL);
    this.subscriber.on('message', (_channel, raw) => {
      try {
        const message = JSON.parse(raw) as PubSubMessage;
        this.emitter.emit(`${message.aggregateType}:${message.aggregateId}`, message);
        this.emitter.emit('*', message);
      } catch {
        // malformed message: ignore
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.subscriber && this.subscriber.status !== 'end') {
      await this.subscriber.quit().catch(() => this.subscriber?.disconnect());
    }
  }

  onAggregate(
    aggregateType: string,
    aggregateId: string,
    handler: (message: PubSubMessage) => void,
  ): () => void {
    const key = `${aggregateType}:${aggregateId}`;
    this.emitter.on(key, handler);
    return () => this.emitter.off(key, handler);
  }

  onAny(handler: (message: PubSubMessage) => void): () => void {
    this.emitter.on('*', handler);
    return () => this.emitter.off('*', handler);
  }
}
