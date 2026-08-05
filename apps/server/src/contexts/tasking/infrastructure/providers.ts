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

/**
 * Jira → tasks. Works against Jira Cloud (Basic auth: JIRA_EMAIL +
 * JIRA_API_TOKEN secrets) and self-hosted Server/DC (Bearer PAT: just
 * JIRA_API_TOKEN). Config: { jql?: string; project?: string } — jql wins;
 * project scopes the default "my open issues" query.
 */
@Injectable()
export class JiraProvider implements TaskSourceProvider {
  readonly kind = 'jira' as const;

  async fetch(source: TaskSource, ctx: TaskSourceProviderContext): Promise<TaskSourceFetch> {
    const config = source.config as { jql?: string; project?: string };
    const base = (ctx.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
    if (!base) throw new Error('jira source: set the JIRA_BASE_URL project secret (e.g. https://yourco.atlassian.net or your self-hosted URL)');
    const token = ctx.env.JIRA_API_TOKEN ?? ctx.env.JIRA_TOKEN;
    if (!token) throw new Error('jira source: set the JIRA_API_TOKEN project secret (+ JIRA_EMAIL for Jira Cloud)');
    const email = ctx.env.JIRA_EMAIL;
    const authorization = email ? `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` : `Bearer ${token}`;

    const jql =
      config.jql ??
      (config.project
        ? `project = ${config.project} AND statusCategory != Done ORDER BY created DESC`
        : 'assignee = currentUser() AND statusCategory != Done ORDER BY created DESC');

    const tasks: ExternalTask[] = [];
    const maxResults = 100;
    let startAt = 0;
    let complete = false;
    for (let page = 0; page < 10; page += 1) {
      const params = new URLSearchParams({ jql, startAt: String(startAt), maxResults: String(maxResults), fields: 'summary,description,labels,created' });
      const res = await fetch(`${base}/rest/api/2/search?${params.toString()}`, {
        headers: { accept: 'application/json', authorization },
      });
      if (!res.ok) {
        throw new Error(`jira search failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      const data = (await res.json()) as {
        total: number;
        issues: Array<{ key: string; fields: { summary: string; description?: unknown; labels?: string[]; created?: string } }>;
      };
      for (const issue of data.issues) {
        tasks.push({
          externalKey: issue.key,
          title: issue.fields.summary,
          // API v2 returns wiki/plain text; Cloud v3 would return ADF objects.
          body: typeof issue.fields.description === 'string' ? issue.fields.description : '',
          ...(issue.fields.created ? { createdAt: issue.fields.created } : {}),
          meta: {
            url: `${base}/browse/${issue.key}`,
            labels: issue.fields.labels ?? [],
          } as { [key: string]: Json },
        });
      }
      startAt += data.issues.length;
      if (data.issues.length === 0 || startAt >= data.total) {
        complete = true;
        break;
      }
    }
    return { tasks, complete };
  }
}
