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
      const queuedRuns: Array<{ id: string }> = await this.ds.query(
        `SELECT id FROM runs WHERE status = 'queued'`,
      );
      for (const { id } of queuedRuns) {
        await this.queues['run.execute'].add(
          'run.execute',
          { runId: id },
          { jobId: `run.execute__${id}` },
        );
        report.requeuedRuns += 1;
      }

      // Flows that are running but have no active step and no pending tick.
      const stalledFlows: Array<{ id: string }> = await this.ds.query(
        `SELECT f.id FROM flow_runs f
          WHERE f.status = 'running'
            AND NOT EXISTS (
              SELECT 1 FROM flow_steps s
               WHERE s.flow_run_id = f.id AND s.status IN ('running','awaiting_input'))`,
      );
      for (const { id } of stalledFlows) {
        await this.queues['flow.advance'].add(
          'flow.advance',
          { flowRunId: id, event: 'reconcile' },
          { jobId: `flow.advance__${id}__reconcile` },
        );
        report.requeuedFlows += 1;
      }

      // Stale-lease active runs: counted here; Phase 4 adds resume/recovery.
      const stale: Array<{ count: string }> = await this.ds.query(
        `SELECT count(*) AS count FROM runs
          WHERE status IN ('provisioning','running','awaiting_input','finalizing')
            AND (lease_at IS NULL OR lease_at < now() - interval '90 seconds')`,
      );
      report.staleActiveRuns = Number(stale[0]?.count ?? 0);
      if (report.staleActiveRuns > 0) {
        this.logger.warn(`${report.staleActiveRuns} active run(s) with stale lease`);
      }
    } catch (error) {
      this.logger.error(`reconciliation failed: ${String(error)}`);
    }
    return report;
  }
}
