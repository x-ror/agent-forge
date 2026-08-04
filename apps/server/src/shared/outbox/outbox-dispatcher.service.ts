import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { DATA_SOURCE } from '../../database/database.module';
import { REDIS } from '../redis/redis.module';
import { QUEUES, type QueueMap } from '../queue/queue.module';
import { routeIntegrationEvent, type OutboxRow } from './event-routing';
import { PUBSUB_CHANNEL, type PubSubMessage } from './integration-event';

const BATCH_SIZE = 100;
const POLL_INTERVAL_MS = 250;

/**
 * The bridge between Postgres truth and Redis delivery (§2.4): polls
 * undispatched outbox rows under FOR UPDATE SKIP LOCKED, enqueues their
 * effects with deterministic jobIds, publishes pub/sub wake-ups, then
 * marks dispatched_at. At-least-once; consumers are idempotent.
 */
@Injectable()
export class OutboxDispatcher {
  private readonly logger = new Logger(OutboxDispatcher.name);
  private timer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUES) private readonly queues: QueueMap,
  ) {}

  start(): void {
    this.stopped = false;
    const tick = async (): Promise<void> => {
      if (this.stopped) return;
      try {
        // Drain fully so a burst doesn't wait a poll interval per batch.
        while ((await this.dispatchOnce()) === BATCH_SIZE) {
          if (this.stopped) return;
        }
      } catch (error) {
        this.logger.error(`dispatch failed: ${String(error)}`);
      }
      this.timer = setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    void tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /** One batch; returns number of rows dispatched. Exposed for tests. */
  async dispatchOnce(): Promise<number> {
    return this.ds.transaction(async (em) => {
      const rows: OutboxRow[] = await em.query(
        `SELECT id, aggregate_type, aggregate_id, event_type, payload
           FROM outbox_events
          WHERE dispatched_at IS NULL
          ORDER BY id
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [BATCH_SIZE],
      );
      if (rows.length === 0) return 0;

      for (const row of rows) {
        for (const job of routeIntegrationEvent(row)) {
          await this.queues[job.queue].add(job.queue, job.data as never, { jobId: job.jobId });
        }
        const message: PubSubMessage = {
          eventType: row.event_type,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          payload: row.payload,
        };
        await this.redis.publish(PUBSUB_CHANNEL, JSON.stringify(message));
      }

      await em.query(`UPDATE outbox_events SET dispatched_at = now() WHERE id = ANY($1)`, [
        rows.map((r) => r.id),
      ]);
      return rows.length;
    });
  }
}
