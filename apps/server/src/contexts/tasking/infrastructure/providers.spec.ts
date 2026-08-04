import { describe, expect, it } from 'vitest';
import { parentNumberFromUrl, parseFileTasksMarkdown } from './providers';

describe('parseFileTasksMarkdown', () => {
  it('keeps legacy TASKS.md flat when the only heading is an h1 doc title', () => {
    const tasks = parseFileTasksMarkdown(['# Tasks', '', '- [ ] Add greeting feature', '- [x] Done already', '- [ ] Another task'].join('\n'), 'TASKS.md');
    expect(tasks.map((t) => t.title)).toEqual(['Add greeting feature', 'Another task']);
    expect(tasks.every((t) => t.meta.parentExternalKey === undefined)).toBe(true);
  });

  it('nests checklist items under ## / ### section headings', () => {
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
    // Auth epic + 2 children, Billing epic + 2 children
    expect(tasks).toHaveLength(6);

    const auth = tasks.find((t) => t.title === 'Auth')!;
    expect(auth.meta.role).toBe('epic');
    expect(auth.externalKey).toBe('file:docs/TASKS.md:epic:auth');

    const login = tasks.find((t) => t.title === 'Login form')!;
    expect(login.meta.parentExternalKey).toBe(auth.externalKey);

    const billing = tasks.find((t) => t.title === 'Billing')!;
    const stripe = tasks.find((t) => t.title === 'Stripe checkout')!;
    const still = tasks.find((t) => t.title.startsWith('Still'))!;
    expect(stripe.meta.parentExternalKey).toBe(billing.externalKey);
    expect(still.meta.parentExternalKey).toBe(billing.externalKey);
  });

  it('treats an explicit "# Epic: …" h1 as a section', () => {
    const tasks = parseFileTasksMarkdown('# Epic: Onboarding\n- [ ] Welcome email\n', 'TASKS.md');
    expect(tasks).toHaveLength(2);
    expect(tasks[0]!.title).toBe('Onboarding');
    expect(tasks[0]!.meta.role).toBe('epic');
    expect(tasks[1]!.meta.parentExternalKey).toBe(tasks[0]!.externalKey);
  });

  it('leaves checklist-only files without epic parents', () => {
    const tasks = parseFileTasksMarkdown('- [ ] Only item\n', 'TASKS.md');
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.meta.role).toBeUndefined();
    expect(tasks[0]!.meta.parentExternalKey).toBeUndefined();
    expect(tasks[0]!.externalKey).toBe('file:TASKS.md:only-item');
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
