import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { APP_ENV, type AppEnv } from '../config/env';
import { RunOrchestrator } from '../contexts/execution/application/run-orchestrator';
import { PROJECT_REPOSITORY, type ProjectRepository } from '../contexts/projects/domain/repositories';
import { ScmService } from '../contexts/scm/application/scm.service';
import { TaskSyncService } from '../contexts/tasking/application/task-sync.service';
import { NotificationsService } from '../contexts/notifications/application/notifications.service';

/**
 * BullMQ consumers (worker entrypoint only). Each Worker gets its own
 * blocking Redis connection; queue payloads are IDs — processors re-read
 * all state from Postgres.
 */
@Injectable()
export class ProcessorsService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(ProcessorsService.name);
  private readonly workers: Worker[] = [];

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    private readonly runOrchestrator: RunOrchestrator,
    private readonly scm: ScmService,
    private readonly taskSync: TaskSyncService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.workers.push(
      new Worker(
        'run.execute',
        async (job) => {
          await this.runOrchestrator.execute((job.data as { runId: string }).runId);
        },
        {
          connection: new IORedis(this.env.REDIS_URL, { maxRetriesPerRequest: null }),
          concurrency: this.env.AGENT_MAX_CONCURRENT_RUNS,
        },
      ),
      new Worker(
        'repo.sync',
        async (job) => {
          const project = await this.projects.findById((job.data as { projectId: string }).projectId);
          if (project) await this.scm.syncMirror(project);
        },
        {
          connection: new IORedis(this.env.REDIS_URL, { maxRetriesPerRequest: null }),
          concurrency: 2,
        },
      ),
      new Worker(
        'task.sync',
        async (job) => {
          await this.taskSync.sync((job.data as { taskSourceId: string }).taskSourceId);
        },
        {
          connection: new IORedis(this.env.REDIS_URL, { maxRetriesPerRequest: null }),
          concurrency: 2,
        },
      ),
      new Worker(
        'notify.deliver',
        async (job) => {
          const data = job.data as { event: unknown; channel: string };
          await this.notifications.deliver({ channel: data.channel, event: data.event });
        },
        {
          connection: new IORedis(this.env.REDIS_URL, { maxRetriesPerRequest: null }),
          concurrency: 5,
        },
      ),
    );
    for (const worker of this.workers) {
      worker.on('failed', (job, error) => {
        this.logger.warn(`${worker.name} job ${job?.id} failed: ${error.message}`);
      });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
