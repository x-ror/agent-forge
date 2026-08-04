import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { collectDefaultMetrics, Gauge, Registry } from 'prom-client';
import { DATA_SOURCE } from '../../database/database.module';
import { QUEUES, type QueueMap } from '../queue/queue.module';
import { QUEUE_NAMES } from '../queue/queues';

/**
 * Prometheus metrics (§14), computed at scrape time from the sources of
 * truth. Token-gated: the endpoint sits behind the global auth guard —
 * scrape with `Authorization: Bearer <PAT>`.
 */
@Controller('metrics')
export class MetricsController {
  private readonly registry = new Registry();
  private readonly queueDepth = new Gauge({
    name: 'agentforge_queue_depth',
    help: 'BullMQ jobs by queue and state',
    labelNames: ['queue', 'state'],
    registers: [this.registry],
  });
  private readonly outboxLag = new Gauge({
    name: 'agentforge_outbox_undispatched',
    help: 'Undispatched outbox rows (count) and max age (seconds)',
    labelNames: ['metric'],
    registers: [this.registry],
  });
  private readonly runsByStatus = new Gauge({
    name: 'agentforge_runs',
    help: 'Runs by status',
    labelNames: ['status'],
    registers: [this.registry],
  });
  private readonly flowsByStatus = new Gauge({
    name: 'agentforge_flow_runs',
    help: 'Flow runs by status',
    labelNames: ['status'],
    registers: [this.registry],
  });
  private readonly runDuration = new Gauge({
    name: 'agentforge_run_duration_seconds',
    help: 'Run wall time over the last 24h',
    labelNames: ['quantile'],
    registers: [this.registry],
  });
  private readonly cost = new Gauge({
    name: 'agentforge_cost_usd_total',
    help: 'Summed run cost (usage.costUsd) over the last 24h',
    registers: [this.registry],
  });

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(QUEUES) private readonly queues: QueueMap,
  ) {
    collectDefaultMetrics({ register: this.registry });
  }

  @Get()
  @Header('content-type', 'text/plain; version=0.0.4')
  async metrics(): Promise<string> {
    for (const name of QUEUE_NAMES) {
      const counts = await this.queues[name].getJobCounts('waiting', 'active', 'delayed', 'failed');
      for (const [state, count] of Object.entries(counts)) {
        this.queueDepth.set({ queue: name, state }, Number(count ?? 0));
      }
    }

    const [outbox] = await this.ds.query(
      `SELECT count(*)::int AS count,
              coalesce(extract(epoch FROM now() - min(created_at)), 0)::float AS max_age
         FROM outbox_events WHERE dispatched_at IS NULL`,
    );
    this.outboxLag.set({ metric: 'count' }, outbox.count);
    this.outboxLag.set({ metric: 'max_age_seconds' }, outbox.max_age);

    for (const row of await this.ds.query(`SELECT status, count(*)::int AS count FROM runs GROUP BY status`)) {
      this.runsByStatus.set({ status: row.status }, row.count);
    }
    for (const row of await this.ds.query(`SELECT status, count(*)::int AS count FROM flow_runs GROUP BY status`)) {
      this.flowsByStatus.set({ status: row.status }, row.count);
    }

    const [durations] = await this.ds.query(
      `SELECT coalesce(percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at)), 0)::float AS p50,
              coalesce(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM finished_at - started_at)), 0)::float AS p95
         FROM runs
        WHERE finished_at IS NOT NULL AND started_at IS NOT NULL
          AND finished_at > now() - interval '24 hours'`,
    );
    this.runDuration.set({ quantile: '0.5' }, durations.p50);
    this.runDuration.set({ quantile: '0.95' }, durations.p95);

    const [cost] = await this.ds.query(
      `SELECT coalesce(sum((usage->>'costUsd')::float), 0)::float AS total
         FROM runs WHERE finished_at > now() - interval '24 hours'`,
    );
    this.cost.set(cost.total);

    return this.registry.metrics();
  }
}
