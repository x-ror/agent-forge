import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UnitOfWork } from '../../../database/unit-of-work';
import { OutboxWriter } from '../../../shared/outbox/outbox.writer';
import { EventTypes } from '../../../shared/outbox/integration-event';
import { uuidv7 } from '../../../shared/uuidv7';
import { PROJECT_REPOSITORY, type ProjectRepository } from '../../projects/domain/repositories';
import { SecretProvisioningService } from '../../projects/application/projects.service';
import { TASK_REPOSITORY, TASK_SOURCE_REPOSITORY, type TaskRepository, type TaskSourceRepository } from '../domain/repositories';
import { TASK_SOURCE_PROVIDERS, type TaskSourceProvider } from '../domain/ports';

/**
 * task.sync (§5.2): pull the external source and upsert tasks on
 * (source_id, external_key). Content refreshes; local board status is
 * never overwritten — re-sync is idempotent.
 */
@Injectable()
export class TaskSyncService {
  private readonly logger = new Logger(TaskSyncService.name);

  constructor(
    @Inject(TASK_SOURCE_REPOSITORY) private readonly sources: TaskSourceRepository,
    @Inject(TASK_REPOSITORY) private readonly tasks: TaskRepository,
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(TASK_SOURCE_PROVIDERS) private readonly providers: TaskSourceProvider[],
    private readonly secrets: SecretProvisioningService,
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxWriter,
  ) {}

  async sync(taskSourceId: string): Promise<{ upserted: number }> {
    const source = await this.sources.findById(taskSourceId);
    if (!source) throw new NotFoundException(`task source ${taskSourceId} not found`);
    const project = await this.projects.findById(source.projectId);
    if (!project) throw new NotFoundException(`project ${source.projectId} not found`);
    const provider = this.providers.find((p) => p.kind === source.kind);
    if (!provider) throw new Error(`no provider for task source kind '${source.kind}'`);

    const external = await provider.fetch(source, {
      env: await this.secrets.decryptedEnv(project.id),
      projectRepoUrl: project.repoUrl,
      projectSettings: project.settings,
      projectId: project.id,
    });

    let upserted = 0;
    for (const task of external) {
      await this.tasks.upsertSynced({
        id: uuidv7(),
        projectId: project.id,
        sourceId: source.id,
        externalKey: task.externalKey,
        title: task.title,
        body: task.body,
        status: 'backlog',
        meta: task.meta,
        ...(task.createdAt ? { sourceCreatedAt: new Date(task.createdAt) } : {}),
      });
      upserted += 1;
    }

    source.lastSyncedAt = new Date();
    await this.uow.withTx(async (em) => {
      await em.query(`UPDATE task_sources SET last_synced_at = now() WHERE id = $1`, [source.id]);
      await this.outbox.append(em, [
        {
          aggregateType: 'task_source',
          aggregateId: source.id,
          eventType: EventTypes.TaskSynced,
          payload: { projectId: project.id, upserted },
        },
      ]);
    });
    this.logger.log(`synced ${upserted} task(s) from ${source.kind} source ${source.id}`);
    return { upserted };
  }
}
