import { Inject, Injectable } from '@nestjs/common';
import type { Json } from '@agentforge/core';
import { parseGithubRepo } from '../../scm/domain/scm';
import { GIT_PORT, type GitPort } from '../../scm/domain/ports';
import { ScmService } from '../../scm/application/scm.service';
import type { TaskSource } from '../domain/task';
import type { ExternalTask, TaskSourceProvider, TaskSourceProviderContext } from '../domain/ports';

/** GitHub Issues → tasks. Config: { repo?: 'owner/name', labels?: string[] }. */
@Injectable()
export class GithubIssuesProvider implements TaskSourceProvider {
  readonly kind = 'github_issues' as const;

  async fetch(source: TaskSource, ctx: TaskSourceProviderContext): Promise<ExternalTask[]> {
    const config = source.config as { repo?: string; labels?: string[] };
    const parsed = config.repo ? { owner: config.repo.split('/')[0]!, repo: config.repo.split('/')[1]! } : parseGithubRepo(ctx.projectRepoUrl);
    if (!parsed) {
      throw new Error('github_issues source: cannot determine owner/repo (set config.repo)');
    }
    const token = ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN;
    const apiBase = ((ctx.projectSettings.githubApiUrl as string | undefined) ?? 'https://api.github.com').replace(/\/$/, '');

    const params = new URLSearchParams({ state: 'open', per_page: '100' });
    if (config.labels?.length) params.set('labels', config.labels.join(','));
    const res = await fetch(`${apiBase}/repos/${parsed.owner}/${parsed.repo}/issues?${params.toString()}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'agentforge',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) {
      throw new Error(`github issues fetch failed: ${res.status} ${await res.text()}`);
    }
    const issues = (await res.json()) as Array<{
      number: number;
      title: string;
      body: string | null;
      html_url: string;
      labels: Array<{ name: string }>;
      pull_request?: unknown;
    }>;
    return issues
      .filter((issue) => !issue.pull_request) // the issues API also returns PRs
      .map((issue) => ({
        externalKey: `${parsed.owner}/${parsed.repo}#${issue.number}`,
        title: issue.title,
        body: issue.body ?? '',
        meta: {
          url: issue.html_url,
          number: issue.number,
          labels: issue.labels.map((l) => l.name),
        } as { [key: string]: Json },
      }));
  }
}

/**
 * Tracked-file source: a markdown checklist in the repo. Config: { path }.
 * Lines like `- [ ] Title` become tasks (unchecked only).
 */
@Injectable()
export class FileTasksProvider implements TaskSourceProvider {
  readonly kind = 'file' as const;

  constructor(
    private readonly scm: ScmService,
    @Inject(GIT_PORT) private readonly git: GitPort,
  ) {}

  async fetch(source: TaskSource, ctx: TaskSourceProviderContext): Promise<ExternalTask[]> {
    const config = source.config as { path?: string; ref?: string };
    const filePath = config.path ?? 'TASKS.md';
    const mirror = await this.scm.ensureMirror({ id: ctx.projectId, repoUrl: ctx.projectRepoUrl });
    const { stdout } = await this.git.run(['-C', mirror, 'show', `${config.ref ?? 'HEAD'}:${filePath}`]);

    const tasks: ExternalTask[] = [];
    for (const line of stdout.split('\n')) {
      const match = /^\s*[-*]\s*\[ \]\s+(.+)$/.exec(line);
      if (!match) continue;
      const title = match[1]!.trim();
      const key = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
      tasks.push({
        externalKey: `file:${filePath}:${key}`,
        title,
        body: '',
        meta: { file: filePath } as { [key: string]: Json },
      });
    }
    return tasks;
  }
}

/** Jira: stub interface per the phase plan — wire config now, implement later. */
@Injectable()
export class JiraProvider implements TaskSourceProvider {
  readonly kind = 'jira' as const;

  async fetch(): Promise<ExternalTask[]> {
    throw new Error('jira task source is not implemented yet (v1 stub)');
  }
}
