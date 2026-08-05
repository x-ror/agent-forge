import { describe, expect, it } from 'vitest';
import { parseFileTasksMarkdown } from './providers';

describe('parseFileTasksMarkdown', () => {
  it('turns unchecked checklist items into tasks and ignores everything else', () => {
    const md = ['# Tasks', '', 'Some prose.', '', '- [ ] Add greeting feature', '- [x] Done already', '* [ ] Star bullet works', '- not a checkbox'].join('\n');
    const tasks = parseFileTasksMarkdown(md, 'TASKS.md');
    expect(tasks.map((t) => t.title)).toEqual(['Add greeting feature', 'Star bullet works']);
    expect(tasks[0]!.externalKey).toBe('file:TASKS.md:add-greeting-feature');
    expect(tasks[0]!.meta).toEqual({ file: 'TASKS.md' });
  });

  it('keys tasks by a slug of the title', () => {
    const tasks = parseFileTasksMarkdown('- [ ] Fix: the (weird) bug!\n', 'docs/TASKS.md');
    expect(tasks[0]!.externalKey).toBe('file:docs/TASKS.md:fix-the-weird-bug');
  });
});

describe('JiraProvider', () => {
  it('paginates the search, maps issues, and reports completeness', async () => {
    const { JiraProvider } = await import('./providers');
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      expect(((init ?? {}).headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('me@co.test:tok').toString('base64')}`);
      const startAt = Number(new URL(String(url)).searchParams.get('startAt'));
      const issues =
        startAt === 0
          ? [
              { key: 'WRK-2', fields: { summary: 'Second', description: 'wiki text', labels: ['backend'], created: '2026-08-01T10:00:00.000+0000' } },
              { key: 'WRK-1', fields: { summary: 'First', description: { adf: true }, labels: [] } },
            ]
          : [{ key: 'WRK-3', fields: { summary: 'Third' } }];
      return new Response(JSON.stringify({ total: 3, issues }), { status: 200 });
    }) as typeof fetch;

    try {
      const provider = new JiraProvider();
      const result = await provider.fetch({ config: { project: 'WRK' } } as never, {
        env: { JIRA_BASE_URL: 'https://co.atlassian.net/', JIRA_API_TOKEN: 'tok', JIRA_EMAIL: 'me@co.test' },
        projectRepoUrl: 'https://gitlab.com/co/app',
        projectSettings: {},
        projectId: 'p',
      });
      expect(result.complete).toBe(true);
      expect(result.tasks.map((t) => t.externalKey)).toEqual(['WRK-2', 'WRK-1', 'WRK-3']);
      expect(result.tasks[0]).toMatchObject({ title: 'Second', body: 'wiki text', createdAt: '2026-08-01T10:00:00.000+0000' });
      expect(result.tasks[0]!.meta.url).toBe('https://co.atlassian.net/browse/WRK-2');
      expect(result.tasks[1]!.body).toBe(''); // ADF object -> empty, never [object Object]
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('project+%3D+WRK');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('demands base url and token secrets with actionable errors', async () => {
    const { JiraProvider } = await import('./providers');
    const provider = new JiraProvider();
    await expect(provider.fetch({ config: {} } as never, { env: {}, projectRepoUrl: '', projectSettings: {}, projectId: 'p' })).rejects.toThrow(/JIRA_BASE_URL/);
    await expect(provider.fetch({ config: {} } as never, { env: { JIRA_BASE_URL: 'https://x' }, projectRepoUrl: '', projectSettings: {}, projectId: 'p' })).rejects.toThrow(
      /JIRA_API_TOKEN/,
    );
  });
});
