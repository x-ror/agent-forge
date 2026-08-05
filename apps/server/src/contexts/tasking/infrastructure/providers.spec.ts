import { describe, expect, it } from 'vitest';
import type { ExternalTask } from '../domain/ports';
import { linkEpicsByBodyTaskLists, parentNumberFromUrl, parseFileTasksMarkdown } from './providers';

describe('parseFileTasksMarkdown', () => {
  it('keeps a plain checklist flat regardless of doc headings', () => {
    const tasks = parseFileTasksMarkdown(['# Tasks', '', '- [ ] Add greeting feature', '- [x] Done already', '- [ ] Another task'].join('\n'), 'TASKS.md');
    expect(tasks.map((t) => t.title)).toEqual(['Add greeting feature', 'Another task']);
    expect(tasks.every((t) => t.meta.parentExternalKeys === undefined)).toBe(true);
  });

  it('groups items under Epic: headings only; plain headings end the group', () => {
    const md = `
# Project board

## Epic: Auth
- [ ] Login form
- [ ] Logout button

## Billing
- [ ] Stripe checkout

- [ ] Still under Billing
`.trim();
    const tasks = parseFileTasksMarkdown(md, 'docs/TASKS.md');
    // Auth epic + 2 children; Billing is a plain section → its items stay flat.
    expect(tasks).toHaveLength(5);

    const auth = tasks.find((t) => t.title === 'Auth')!;
    expect(auth.meta.role).toBe('epic');
    expect(auth.externalKey).toBe('file:docs/TASKS.md:epic:auth');

    const login = tasks.find((t) => t.title === 'Login form')!;
    const logout = tasks.find((t) => t.title === 'Logout button')!;
    expect(login.meta.parentExternalKeys).toEqual([auth.externalKey]);
    expect(logout.meta.parentExternalKeys).toEqual([auth.externalKey]);

    const stripe = tasks.find((t) => t.title === 'Stripe checkout')!;
    const still = tasks.find((t) => t.title.startsWith('Still'))!;
    expect(stripe.meta.parentExternalKeys).toBeUndefined();
    expect(still.meta.parentExternalKeys).toBeUndefined();
    expect(tasks.find((t) => t.title === 'Billing')).toBeUndefined();
  });

  it('accepts Epic: at any heading level, including h1', () => {
    const tasks = parseFileTasksMarkdown('# Epic: Onboarding\n- [ ] Welcome email\n', 'TASKS.md');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.title).toBe('Onboarding');
    expect(tasks[0]!.meta.role).toBe('epic');
    expect(tasks[1]!.meta.parentExternalKeys).toEqual([tasks[0]!.externalKey]);
  });

  it('does not emit an epic that has no unchecked items', () => {
    const md = ['## Epic: Empty', '', '## Epic: Real', '- [ ] Only item'].join('\n');
    const tasks = parseFileTasksMarkdown(md, 'TASKS.md');
    expect(tasks.map((t) => t.title)).toEqual(['Real', 'Only item']);
  });

  it('leaves checklist-only files without epic parents', () => {
    const tasks = parseFileTasksMarkdown('- [ ] Only item\n', 'TASKS.md');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.meta.role).toBeUndefined();
    expect(tasks[0]!.meta.parentExternalKeys).toBeUndefined();
    expect(tasks[0]!.externalKey).toBe('file:TASKS.md:only-item');
  });
});

describe('linkEpicsByBodyTaskLists', () => {
  const issue = (number: number, extra: Partial<ExternalTask> & { meta?: ExternalTask['meta'] } = {}): ExternalTask => ({
    externalKey: `acme/widget#${number}`,
    title: `Issue ${number}`,
    body: '',
    ...extra,
    meta: { number, ...extra.meta },
  });

  it('records membership for body task-list refs and derives progress from checkboxes', () => {
    const epic = issue(1, {
      body: ['Umbrella tracker.', '', '### Sub-issues', '', '- [ ] #2 — net sockets', '- [x] #99 — already closed, not synced', '- [ ] #3'].join('\n'),
      meta: { number: 1, role: 'epic', subIssues: { total: 0, completed: 0 } },
    });
    const childA = issue(2);
    const childB = issue(3);
    linkEpicsByBodyTaskLists([epic, childA, childB]);

    expect(childA.meta.parentExternalKeys).toEqual(['acme/widget#1']);
    expect(childB.meta.parentExternalKeys).toEqual(['acme/widget#1']);
    // 3 refs, 1 checked — the closed #99 still counts toward progress.
    expect(epic.meta.subIssues).toEqual({ total: 3, completed: 1 });
  });

  it('a task referenced by several epics belongs to all of them', () => {
    const index = issue(10, { body: '- [ ] #11\n- [ ] #12', meta: { number: 10, role: 'epic' } });
    const themed = issue(11, { body: '- [ ] #12', meta: { number: 11, role: 'epic' } });
    const shared = issue(12);
    linkEpicsByBodyTaskLists([index, themed, shared]);

    expect(shared.meta.parentExternalKeys).toEqual(['acme/widget#10', 'acme/widget#11']);
    // Epics can be members of an index epic — they are filters, not containers.
    expect(themed.meta.parentExternalKeys).toEqual(['acme/widget#10']);
  });

  it('keeps native sub-issue progress but still records membership', () => {
    const epic = issue(1, { body: '- [ ] #2', meta: { number: 1, role: 'epic', subIssues: { total: 4, completed: 2 } } });
    const child = issue(2);
    linkEpicsByBodyTaskLists([epic, child]);

    expect(epic.meta.subIssues).toEqual({ total: 4, completed: 2 });
    expect(child.meta.parentExternalKeys).toEqual(['acme/widget#1']);
  });

  it('merges body membership with a native parent link', () => {
    const epic = issue(1, { body: '- [ ] #2', meta: { number: 1, role: 'epic' } });
    const child = issue(2, { meta: { number: 2, parentExternalKeys: ['acme/widget#7'] } });
    linkEpicsByBodyTaskLists([epic, child]);

    expect(child.meta.parentExternalKeys).toEqual(['acme/widget#7', 'acme/widget#1']);
  });
});

describe('parentNumberFromUrl', () => {
  it('extracts the issue number from a parent_issue_url', () => {
    expect(parentNumberFromUrl('https://api.github.com/repos/acme/widget/issues/42')).toBe(42);
    expect(parentNumberFromUrl('https://api.github.com/repos/acme/widget/issues/7?foo=1')).toBe(7);
    expect(parentNumberFromUrl(null)).toBeNull();
    expect(parentNumberFromUrl(undefined)).toBeNull();
  });
});
