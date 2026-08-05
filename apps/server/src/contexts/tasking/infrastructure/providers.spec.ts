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

describe('adfToText', () => {
  it('flattens paragraphs, marks, lists and hard breaks into readable text', async () => {
    const { adfToText } = await import('./providers');
    const adf = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Fix the ' },
            { type: 'text', text: 'crawler', marks: [{ type: 'strong' }] },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'retry on 429' }] }] }] },
      ],
    };
    expect(adfToText(adf)).toBe('Fix the crawler\nline one\nline two\nretry on 429');
    expect(adfToText(undefined)).toBe('');
    expect(adfToText('nope')).toBe('');
  });
});

describe('JiraProvider', () => {
  it('uses Cloud v3 token pagination, maps issues, extracts ADF bodies', async () => {
    const { JiraProvider } = await import('./providers');
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      expect(((init ?? {}).headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from('me@co.test:tok').toString('base64')}`);
      expect(String(url)).toContain('/rest/api/3/search/jql?');
      const token = new URL(String(url)).searchParams.get('nextPageToken');
      const body =
        token === null
          ? {
              nextPageToken: 'page-2',
              issues: [
                { key: 'PC-2', fields: { summary: 'Second', description: 'plain text', labels: ['backend'], created: '2026-08-01T10:00:00.000+0000' } },
                {
                  key: 'PC-1',
                  fields: { summary: 'First', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'adf body' }] }] }, labels: [] },
                },
              ],
            }
          : { issues: [{ key: 'PC-3', fields: { summary: 'Third' } }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;

    try {
      const provider = new JiraProvider();
      const result = await provider.fetch({ config: { project: 'PC' } } as never, {
        env: { JIRA_BASE_URL: 'https://co.atlassian.net/', JIRA_API_TOKEN: 'tok', JIRA_EMAIL: 'me@co.test' },
        projectRepoUrl: 'https://gitlab.com/co/app',
        projectSettings: {},
        projectId: 'p',
      });
      expect(result.complete).toBe(true);
      expect(result.tasks.map((t) => t.externalKey)).toEqual(['PC-2', 'PC-1', 'PC-3']);
      expect(result.tasks[0]).toMatchObject({ title: 'Second', body: 'plain text', createdAt: '2026-08-01T10:00:00.000+0000' });
      expect(result.tasks[0]!.meta.url).toBe('https://co.atlassian.net/browse/PC-2');
      expect(result.tasks[1]!.body).toBe('adf body'); // ADF object -> extracted text, never [object Object]
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('project+%3D+PC');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to the v2 search when the instance has no api/3 (Server/DC)', async () => {
    const { JiraProvider } = await import('./providers');
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push(String(url));
      expect(((init ?? {}).headers as Record<string, string>).authorization).toBe('Bearer pat');
      if (String(url).includes('/rest/api/3/')) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify({ total: 1, issues: [{ key: 'SRV-1', fields: { summary: 'Only', description: 'wiki text' } }] }), { status: 200 });
    }) as typeof fetch;

    try {
      const provider = new JiraProvider();
      const result = await provider.fetch({ config: { jql: 'assignee = currentUser()' } } as never, {
        env: { JIRA_BASE_URL: 'https://jira.co.test', JIRA_API_TOKEN: 'pat' },
        projectRepoUrl: '',
        projectSettings: {},
        projectId: 'p',
      });
      expect(result.complete).toBe(true);
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0]).toMatchObject({ externalKey: 'SRV-1', body: 'wiki text' });
      expect(calls[0]).toContain('/rest/api/3/search/jql?');
      expect(calls[1]).toContain('/rest/api/2/search?');
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
