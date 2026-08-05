import { Inject, Injectable, Logger } from '@nestjs/common';
import { TaskSyncService } from '../contexts/tasking/application/task-sync.service';
import { TASK_SOURCE_REPOSITORY, type TaskSourceRepository } from '../contexts/tasking/domain/repositories';

/**
 * Cron-ish source syncs: every minute, sources whose sync_cron interval has
 * elapsed since last_synced_at sync again. The cron string is interpreted as
 * an interval (the granularity we honor), not a wall-clock schedule:
 * every-N-minutes → N, hourly patterns → 60, daily → 1440.
 */
export function cronIntervalMinutes(cron: string): number | null {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour] = fields as [string, string, ...string[]];
  const everyN = /^\*\/(\d+)$/.exec(minute);
  if (everyN && hour === '*') return Math.max(1, Number(everyN[1]));
  if (minute === '*') return 1;
  if (hour === '*') return 60;
  const everyNHours = /^\*\/(\d+)$/.exec(hour);
  if (everyNHours) return Math.max(1, Number(everyNHours[1])) * 60;
  return 24 * 60;
}

@Injectable()
export class SyncSchedulerService {
  private readonly logger = new Logger(SyncSchedulerService.name);
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    @Inject(TASK_SOURCE_REPOSITORY) private readonly sources: TaskSourceRepository,
    private readonly taskSync: TaskSyncService,
  ) {}

  start(intervalMs = 60_000): void {
    this.timer = setInterval(() => void this.tick(), intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now = new Date()): Promise<void> {
    if (this.running) return; // a slow sync must not stack ticks
    this.running = true;
    try {
      const withCron = await this.sources.listWithCron();
      for (const source of withCron) {
        const interval = source.syncCron ? cronIntervalMinutes(source.syncCron) : null;
        if (interval === null) continue;
        const last = source.lastSyncedAt?.getTime() ?? 0;
        if (now.getTime() - last < interval * 60_000) continue;
        try {
          await this.taskSync.sync(source.id);
        } catch (error) {
          this.logger.warn(`scheduled sync for source ${source.id} failed: ${String(error).slice(0, 300)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
