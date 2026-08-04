import { Inject, Injectable, Logger } from '@nestjs/common';
import { PROJECT_REPOSITORY, type ProjectRepository } from '../../projects/domain/repositories';
import { SecretProvisioningService } from '../../projects/application/projects.service';
import { parseGithubRepo } from '../../scm/domain/scm';
import { GITHUB_PORT, type GithubPort } from '../../scm/domain/ports';

export interface NotifyDelivery {
  channel: string;
  event: unknown;
}

/**
 * notify.deliver consumer (§5.2). Channels: 'log' (always available),
 * 'github-comment' (outcome write-back to the source issue — the Tasking
 * DoD capability), 'webhook'.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(GITHUB_PORT) private readonly github: GithubPort,
    private readonly secrets: SecretProvisioningService,
  ) {}

  async deliver(delivery: NotifyDelivery): Promise<void> {
    switch (delivery.channel) {
      case 'github-comment':
        await this.githubComment(delivery.event as GithubCommentEvent);
        return;
      case 'webhook':
        await this.webhook(delivery.event as WebhookEvent);
        return;
      default:
        this.logger.log(`notify[log]: ${JSON.stringify(delivery.event).slice(0, 500)}`);
    }
  }

  private async githubComment(event: GithubCommentEvent): Promise<void> {
    const project = await this.projects.findById(event.projectId);
    if (!project) throw new Error(`project ${event.projectId} not found`);
    const repo = parseGithubRepo(project.repoUrl);
    if (!repo) throw new Error('project repo is not a GitHub repo');
    const env = await this.secrets.decryptedEnv(project.id);
    const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    if (!token) throw new Error('no GITHUB_TOKEN secret for write-back');
    await this.github.commentOnIssue({
      apiBase:
        typeof project.settings.githubApiUrl === 'string'
          ? project.settings.githubApiUrl
          : undefined,
      token,
      repo,
      issueNumber: event.issueNumber,
      body: event.body,
    });
  }

  private async webhook(event: WebhookEvent): Promise<void> {
    const res = await fetch(event.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(event.payload ?? {}),
    });
    if (!res.ok) throw new Error(`webhook delivery failed: ${res.status}`);
  }
}

interface GithubCommentEvent {
  projectId: string;
  issueNumber: number;
  body: string;
}

interface WebhookEvent {
  url: string;
  payload?: unknown;
}
