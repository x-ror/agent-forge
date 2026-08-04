import { Controller, Get, Inject } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { Redis } from 'ioredis';
import { DATA_SOURCE } from '../database/database.module';
import { Public } from '../shared/http/auth.decorators';
import { QUEUES, type QueueMap } from '../shared/queue/queue.module';
import { REDIS } from '../shared/redis/redis.module';
import { QUEUE_NAMES } from '../shared/queue/queues';
import { WORKER_HEARTBEAT_KEY } from '../worker/heartbeat.service';

const HEARTBEAT_FRESH_MS = 45_000;

interface HealthReport {
  status: 'ok' | 'degraded';
  postgres: boolean;
  redis: boolean;
  worker: { heartbeatAgeMs: number | null; fresh: boolean };
  queues: Record<string, { waiting: number; active: number; delayed: number; failed: number }>;
}

@Controller('health')
export class HealthController {
  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(QUEUES) private readonly queues: QueueMap,
  ) {}

  @Public()
  @Get()
  async health(): Promise<HealthReport> {
    const report: HealthReport = {
      status: 'ok',
      postgres: false,
      redis: false,
      worker: { heartbeatAgeMs: null, fresh: false },
      queues: {},
    };

    try {
      await this.ds.query('SELECT 1');
      report.postgres = true;
    } catch {
      /* stays false */
    }

    try {
      report.redis = (await this.redis.ping()) === 'PONG';
      const beat = await this.redis.get(WORKER_HEARTBEAT_KEY);
      if (beat) {
        const age = Date.now() - new Date(beat).getTime();
        report.worker = { heartbeatAgeMs: age, fresh: age < HEARTBEAT_FRESH_MS };
      }
      for (const name of QUEUE_NAMES) {
        const counts = await this.queues[name].getJobCounts(
          'waiting',
          'active',
          'delayed',
          'failed',
        );
        report.queues[name] = {
          waiting: counts.waiting ?? 0,
          active: counts.active ?? 0,
          delayed: counts.delayed ?? 0,
          failed: counts.failed ?? 0,
        };
      }
    } catch {
      report.redis = false;
    }

    report.status = report.postgres && report.redis ? 'ok' : 'degraded';
    return report;
  }
}
