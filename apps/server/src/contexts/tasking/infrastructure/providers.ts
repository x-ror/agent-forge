import { Inject, Injectable } from '@nestjs/common';
import type { Json } from '@agentforge/core';
import { parseGithubRepo } from '../../scm/domain/scm';
import { GIT_PORT, type GitPort } from '../../scm/domain/ports';
import { ScmService } from '../../scm/application/scm.service';
import type { TaskSource } from '../domain/task';
import type { ExternalTask, TaskSourceProvider, TaskSourceProviderContext } from '../domain/ports';

function slugKey(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Parse parent issue number from a GitHub API parent_issue_url. */
export function parentNumberFromUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const match = /\/issues\/(\d+)(?:\?|$)/.exec(url);
  return match ? Number(match[1]) : null;
}

/**
 * Tracked-file markdown → external tasks.
 *
 * - Unchecked checklist items (`- [ ] Title`) become tasks.
 * - One grouping rule: a heading whose title starts with `Epic:` (any `#`
 *   level) collects the checklist items below it under an epic parent
 *   (`meta.role = 'epic'`, children get `meta.parentExternalKey`). Every
 *   other heading simply ends the current group — plain sections like
 *   `## Notes` never become epics by accident.
 * - An epic with no unchecked items is not emitted (no dangling epic rows).
 */
export function parseFileTasksMarkdown(content: string, filePath: string): ExternalTask[] {
  const tasks: ExternalTask[] = [];
  let epic: ExternalTask | null = null;
  let epicEmitted = false;

  for (const raw of content.split('\n')) {
    const line = raw.trim();
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading) {
      const epicTitle = /^epic\s*[:\-–—]\s*(.+)$/i.exec(heading[1]!.trim());
      if (epicTitle) {
        const title = epicTitle[1]!.trim();
        epic = {
          externalKey: `file:${filePath}:epic:${slugKey(title) || 'epic'}`,
          title,
          body: '',
          meta: { file: filePath, role: 'epic' } as { [key: string]: Json },
        };
        epicEmitted = false;
      } else {
        epic = null;
      }
      continue;
    }

    const match = /^[-*]\s*\[ \]\s+(.+)$/.exec(line);
    if (!match) continue;
    const title = match[1]!.trim();
    const meta: { [key: string]: Json } = { file: filePath };
    if (epic) {
      if (!epicEmitted) {
        tasks.push(epic);
        epicEmitted = true;
      }
      meta.parentExternalKey = epic.externalKey;
    }
    tasks.push({
      externalKey: `file:${filePath}:${slugKey(title)}`,
      title,
      body: '',
      meta,
    });
  }
  return tasks;
}

/** GitHub task-list references in an issue body: `- [ ] #80 …` / `- [x] #80 …`. */
function bodyTaskRefs(body: string): Array<{ number: number; checked: boolean }> {
  const refs: Array<{ number: number; checked: boolean }> = [];
  for (const raw of body.split('\n')) {
    const match = /^\s*[-*]\s*\[([ xX])\]\s*[^#\n]*#(\d+)/.exec(raw);
    if (match) refs.push({ number: Number(match[2]), checked: match[1] !== ' ' });
  }
  return refs;
}

/**
 * Labeled-epic fallback: repos that don't use GitHub's native sub-issues often
 * keep a task-list of issue refs in the epic body. Derive child links
 * (meta.parentExternalKey) and progress (meta.subIssues from the checkboxes —
 * checked refs count as done even though closed issues are never synced).
 * Native sub-issue data wins when present; an epic is never linked as another
 * epic's child (the board tree is one level, so it would orphan its own
 * children); the first epic to reference an issue keeps it.
 */
export function linkEpicsByBodyTaskLists(tasks: ExternalTask[]): void {
  const byNumber = new Map<number, ExternalTask>();
  for (const t of tasks) {
    if (typeof t.meta.number === 'number') byNumber.set(t.meta.number, t);
  }
  for (const epic of tasks) {
    if (epic.meta.role !== 'epic') continue;
    const native = epic.meta.subIssues as { total?: number } | undefined;
    if ((native?.total ?? 0) > 0) continue;
    const refs = bodyTaskRefs(epic.body);
    if (refs.length === 0) continue;
    epic.meta.subIssues = { total: refs.length, completed: refs.filter((r) => r.checked).length };
    for (const ref of refs) {
      const child = byNumber.get(ref.number);
      if (!child || child === epic || child.meta.role === 'epic') continue;
      if (child.meta.parentExternalKey === undefined) child.meta.parentExternalKey = epic.externalKey;
    }
  }
}

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
      parent_issue_url?: string | null;
      sub_issues_summary?: { total?: number; completed?: number; percent_completed?: number } | null;
    }>;

    const externalTasks = issues
      .filter((issue) => !issue.pull_request) // the issues API also returns PRs
      .map((issue) => {
        const labels = issue.labels.map((l) => l.name);
        const parentNum = parentNumberFromUrl(issue.parent_issue_url);
        const parentExternalKey = parentNum != null ? `${parsed.owner}/${parsed.repo}#${parentNum}` : null;
        const hasSubIssues = (issue.sub_issues_summary?.total ?? 0) > 0;
        const labeledEpic = labels.some((l) => /^epic$/i.test(l));
        const meta: { [key: string]: Json } = {
          url: issue.html_url,
          number: issue.number,
          labels,
        };
        if (parentExternalKey) meta.parentExternalKey = parentExternalKey;
        if (labeledEpic || hasSubIssues) meta.role = 'epic';
        if (issue.sub_issues_summary) {
          meta.subIssues = {
            total: issue.sub_issues_summary.total ?? 0,
            completed: issue.sub_issues_summary.completed ?? 0,
          };
        }
        return {
          externalKey: `${parsed.owner}/${parsed.repo}#${issue.number}`,
          title: issue.title,
          body: issue.body ?? '',
          meta,
        };
      });
    linkEpicsByBodyTaskLists(externalTasks);
    return externalTasks;
  }
}

/**
 * Tracked-file source: a markdown checklist in the repo. Config: { path }.
 * Lines like `- [ ] Title` become tasks (unchecked only). `Epic:` headings
 * group subsequent items under an epic parent (see parseFileTasksMarkdown).
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
    return parseFileTasksMarkdown(stdout, filePath);
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
