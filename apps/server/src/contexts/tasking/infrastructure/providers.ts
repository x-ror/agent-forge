import { Inject, Injectable } from '@nestjs/common';
import type { Json } from '@agentforge/core';
import { parseGithubRepo } from '../../scm/domain/scm';
import { GIT_PORT, type GitPort } from '../../scm/domain/ports';
import { ScmService } from '../../scm/application/scm.service';
import type { TaskSource } from '../domain/task';
import type { ExternalTask, TaskSourceFetch, TaskSourceProvider, TaskSourceProviderContext } from '../domain/ports';

function slugKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/**
 * Tracked-file markdown → external tasks: every unchecked checklist item
 * (`- [ ] Title`) becomes a task; headings and prose are ignored.
 */
export function parseFileTasksMarkdown(content: string, filePath: string): ExternalTask[] {
  const tasks: ExternalTask[] = [];
  for (const raw of content.split('\n')) {
    const match = /^[-*]\s*\[ \]\s+(.+)$/.exec(raw.trim());
    if (!match) continue;
    const title = match[1]!.trim();
    tasks.push({
      externalKey: `file:${filePath}:${slugKey(title)}`,
      title,
      body: '',
      meta: { file: filePath },
    });
  }
  return tasks;
}

/** GitHub Issues → tasks. Config: { repo?: 'owner/name', labels?: string[] }. */
@Injectable()
export class GithubIssuesProvider implements TaskSourceProvider {
  readonly kind = 'github_issues' as const;

  async fetch(source: TaskSource, ctx: TaskSourceProviderContext): Promise<TaskSourceFetch> {
    const config = source.config as { repo?: string; labels?: string[] };
    const parsed = config.repo ? { owner: config.repo.split('/')[0]!, repo: config.repo.split('/')[1]! } : parseGithubRepo(ctx.projectRepoUrl);
    if (!parsed) {
      throw new Error('github_issues source: cannot determine owner/repo (set config.repo)');
    }
    const token = ctx.env.GITHUB_TOKEN ?? ctx.env.GH_TOKEN;
    const apiBase = ((ctx.projectSettings.githubApiUrl as string | undefined) ?? 'https://api.github.com').replace(/\/$/, '');

    const perPage = 100;
    const maxPages = 10; // 1000 open issues — beyond that we refuse to claim completeness
    const tasks: ExternalTask[] = [];
    let complete = false;
    for (let page = 1; page <= maxPages; page += 1) {
      const params = new URLSearchParams({ state: 'open', per_page: String(perPage), page: String(page) });
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
        created_at?: string;
      }>;

      for (const issue of issues) {
        if (issue.pull_request) continue; // the issues API also returns PRs
        tasks.push({
          externalKey: `${parsed.owner}/${parsed.repo}#${issue.number}`,
          title: issue.title,
          body: issue.body ?? '',
          ...(issue.created_at ? { createdAt: issue.created_at } : {}),
          meta: {
            url: issue.html_url,
            number: issue.number,
            labels: issue.labels.map((l) => l.name),
          } as { [key: string]: Json },
        });
      }
      if (issues.length < perPage) {
        complete = true;
        break;
      }
    }
    return { tasks, complete };
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

  async fetch(source: TaskSource, ctx: TaskSourceProviderContext): Promise<TaskSourceFetch> {
    const config = source.config as { path?: string; ref?: string };
    const filePath = config.path ?? 'TASKS.md';
    const mirror = await this.scm.ensureMirror({ id: ctx.projectId, repoUrl: ctx.projectRepoUrl });
    const { stdout } = await this.git.run(['-C', mirror, 'show', `${config.ref ?? 'HEAD'}:${filePath}`]);
    return { tasks: parseFileTasksMarkdown(stdout, filePath), complete: true };
  }
}

/** Jira: stub interface per the phase plan — wire config now, implement later. */
@Injectable()
export class JiraProvider implements TaskSourceProvider {
  readonly kind = 'jira' as const;

  async fetch(): Promise<TaskSourceFetch> {
    throw new Error('jira task source is not implemented yet (v1 stub)');
  }
}
