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
