import { describe, expect, it } from 'vitest';
import type { ExternalTask } from '../domain/ports';
import { linkEpicsByBodyTaskLists, parentNumberFromUrl, parseFileTasksMarkdown } from './providers';

describe('parseFileTasksMarkdown', () => {
  it('keeps a plain checklist flat regardless of doc headings', () => {
    const tasks = parseFileTasksMarkdown(['# Tasks', '', '- [ ] Add greeting feature', '- [x] Done already', '- [ ] Another task'].join('\n'), 'TASKS.md');
    expect(tasks.map((t) => t.title)).toEqual(['Add greeting feature', 'Another task']);
    expect(tasks.every((t) => t.meta.parentExternalKey === undefined)).toBe(true);
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
    expect(login.meta.parentExternalKey).toBe(auth.externalKey);
    expect(logout.meta.parentExternalKey).toBe(auth.externalKey);

    const stripe = tasks.find((t) => t.title === 'Stripe checkout')!;
    const still = tasks.find((t) => t.title.startsWith('Still'))!;
    expect(stripe.meta.parentExternalKey).toBeUndefined();
    expect(still.meta.parentExternalKey).toBeUndefined();
    expect(tasks.find((t) => t.title === 'Billing')).toBeUndefined();
  });

  it('accepts Epic: at any heading level, including h1', () => {
    const tasks = parseFileTasksMarkdown('# Epic: Onboarding\n- [ ] Welcome email\n', 'TASKS.md');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.title).toBe('Onboarding');
    expect(tasks[0]!.meta.role).toBe('epic');
    expect(tasks[1]!.meta.parentExternalKey).toBe(tasks[0]!.externalKey);
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
    expect(tasks[0]!.meta.parentExternalKey).toBeUndefined();
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

  it('links body task-list refs as children and derives progress from checkboxes', () => {
    const epic = issue(1, {
      body: ['Umbrella tracker.', '', '### Sub-issues', '', '- [ ] #2 — net sockets', '- [x] #99 — already closed, not synced', '- [ ] #3'].join('\n'),
      meta: { number: 1, role: 'epic', subIssues: { total: 0, completed: 0 } },
    });
    const childA = issue(2);
    const childB = issue(3);
    const tasks = [epic, childA, childB];
    linkEpicsByBodyTaskLists(tasks);

    expect(childA.meta.parentExternalKey).toBe('acme/widget#1');
    expect(childB.meta.parentExternalKey).toBe('acme/widget#1');
    // 3 refs, 1 checked — the closed #99 still counts toward progress.
    expect(epic.meta.subIssues).toEqual({ total: 3, completed: 1 });
  });

  it('never links an epic as another epic’s child and keeps first-claim wins', () => {
    const index = issue(10, { body: '- [ ] #11\n- [ ] #12', meta: { number: 10, role: 'epic' } });
    const nestedEpic = issue(11, { body: '- [ ] #12', meta: { number: 11, role: 'epic' } });
    const child = issue(12);
    linkEpicsByBodyTaskLists([index, nestedEpic, child]);

    expect(nestedEpic.meta.parentExternalKey).toBeUndefined();
    expect(child.meta.parentExternalKey).toBe('acme/widget#10'); // index claimed it first
  });

  it('leaves epics with native sub-issue data alone', () => {
    const epic = issue(1, { body: '- [ ] #2', meta: { number: 1, role: 'epic', subIssues: { total: 4, completed: 2 } } });
    const child = issue(2);
    linkEpicsByBodyTaskLists([epic, child]);

    expect(epic.meta.subIssues).toEqual({ total: 4, completed: 2 });
    expect(child.meta.parentExternalKey).toBeUndefined();
  });

  it('respects native parent links over body refs', () => {
    const epic = issue(1, { body: '- [ ] #2', meta: { number: 1, role: 'epic' } });
    const child = issue(2, { meta: { number: 2, parentExternalKey: 'acme/widget#7' } });
    linkEpicsByBodyTaskLists([epic, child]);

    expect(child.meta.parentExternalKey).toBe('acme/widget#7');
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
