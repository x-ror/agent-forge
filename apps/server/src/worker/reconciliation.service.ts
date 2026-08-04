import { Inject, Injectable, Logger } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../database/database.module';
import { QUEUES, type QueueMap } from '../shared/queue/queue.module';

export interface ReconciliationReport {
  requeuedRuns: number;
  requeuedFlows: number;
  staleActiveRuns: number;
}

/**
 * §5.4: runs against Postgres at boot and every 60s. Because job ids are
 * deterministic, re-enqueueing is idempotent — this alone rebuilds Redis
 * from zero after a flush.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);
  private timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATA_SOURCE) private readonly ds: DataSource,
    @Inject(QUEUES) private readonly queues: QueueMap,
  ) {}

  start(intervalMs = 60_000): void {
    void this.run();
    this.timer = setInterval(() => void this.run(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async run(): Promise<ReconciliationReport> {
    const report: ReconciliationReport = { requeuedRuns: 0, requeuedFlows: 0, staleActiveRuns: 0 };
    try {
      // Queued runs must always have an execute job (jobId dedupes).
      const queuedRuns: Array<{ id: string }> = await this.ds.query(`SELECT id FROM runs WHERE status = 'queued'`);
      for (const { id } of queuedRuns) {
        await this.queues['run.execute'].add('run.execute', { runId: id }, { jobId: `run.execute__${id}` });
        report.requeuedRuns += 1;
      }

      // Every active flow gets a periodic tick (idempotent; the engine's
      // planning pass is a no-op unless state moved). Covers crash recovery
      // AND gate timeouts (§5.4, §7.3).
      const activeFlows: Array<{ id: string }> = await this.ds.query(`SELECT id FROM flow_runs WHERE status IN ('running','awaiting_input')`);
      const flowBucket = Math.floor(Date.now() / 60_000);
      for (const { id } of activeFlows) {
        await this.queues['flow.advance'].add('flow.advance', { flowRunId: id, event: 'reconcile' }, { jobId: `flow.advance__${id}__reconcile__${flowBucket}` });
        report.requeuedFlows += 1;
      }

      // Stale-lease active runs → recovery jobs; the orchestrator decides
      // resume vs honest crash_recovered failure (§5.4).
      const stale: Array<{ id: string }> = await this.ds.query(
        `SELECT id FROM runs
          WHERE status IN ('provisioning','running','awaiting_input','finalizing')
            AND (lease_at IS NULL OR lease_at < now() - interval '90 seconds')`,
      );
      report.staleActiveRuns = stale.length;
      // Time-bucketed jobId: retryable later, deduped within the window.
      const bucket = Math.floor(Date.now() / 300_000);
      for (const { id } of stale) {
        await this.queues['run.execute'].add('run.execute', { runId: id }, { jobId: `run.execute__${id}__recover__${bucket}` });
      }
      if (report.staleActiveRuns > 0) {
        this.logger.warn(`${report.staleActiveRuns} stale run(s) queued for recovery`);
      }
    } catch (error) {
      this.logger.error(`reconciliation failed: ${String(error)}`);
    }
    return report;
  }
}
