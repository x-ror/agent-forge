import { describe, expect, it } from 'vitest';
import type { TaskDto } from '@agentforge/core';
import { buildEpicFilters, leafTasks, parentKeys, taskRole, taskUrl } from './task-epics';

function task(partial: Partial<TaskDto> & Pick<TaskDto, 'id' | 'title'>): TaskDto {
  return {
    projectId: 'p',
    sourceId: null,
    externalKey: null,
    body: '',
    status: 'backlog',
    meta: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('parentKeys', () => {
  it('reads the membership array', () => {
    expect(parentKeys(task({ id: '1', title: 'x', meta: { parentExternalKeys: ['a#1', 'a#2'] } }))).toEqual(['a#1', 'a#2']);
  });

  it('falls back to the legacy singular key', () => {
    expect(parentKeys(task({ id: '1', title: 'x', meta: { parentExternalKey: 'a#1' } }))).toEqual(['a#1']);
    expect(parentKeys(task({ id: '2', title: 'x' }))).toEqual([]);
  });
});

describe('leafTasks', () => {
  const epic = task({ id: 'e', title: 'Epic', externalKey: 'a#1', meta: { role: 'epic' } });
  const inEpic = task({ id: 'a', title: 'A', meta: { parentExternalKeys: ['a#1'] } });
  const shared = task({ id: 'b', title: 'B', meta: { parentExternalKeys: ['a#1', 'a#2'] } });
  const solo = task({ id: 'c', title: 'C' });

  it('lists all non-epic tasks when no filter is active', () => {
    expect(leafTasks([epic, inEpic, shared, solo], null).map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('filters by epic membership — a shared task matches several epics', () => {
    expect(leafTasks([epic, inEpic, shared, solo], 'a#1').map((t) => t.id)).toEqual(['a', 'b']);
    expect(leafTasks([epic, inEpic, shared, solo], 'a#2').map((t) => t.id)).toEqual(['b']);
  });
});

describe('buildEpicFilters', () => {
  it('prefers sync-derived progress and sorts by total desc', () => {
    const big = task({ id: 'e1', title: 'Zeta', externalKey: 'a#1', meta: { role: 'epic', subIssues: { total: 24, completed: 19 } } });
    const small = task({ id: 'e2', title: 'Alpha', externalKey: 'a#2', meta: { role: 'epic', subIssues: { total: 4, completed: 0 } } });
    const member = task({ id: 'm', title: 'M', meta: { parentExternalKeys: ['a#1', 'a#2'] } });

    const filters = buildEpicFilters([small, big, member]);
    expect(filters.map((f) => f.task.id)).toEqual(['e1', 'e2']);
    expect(filters[0]).toMatchObject({ done: 19, total: 24, memberCount: 1 });
  });

  it('falls back to visible member statuses when no summary exists', () => {
    const epic = task({ id: 'e', title: 'Epic', externalKey: 'f:e', meta: { role: 'epic' } });
    const done = task({ id: 'a', title: 'A', status: 'done', meta: { parentExternalKeys: ['f:e'] } });
    const open = task({ id: 'b', title: 'B', meta: { parentExternalKeys: ['f:e'] } });

    const filters = buildEpicFilters([epic, done, open]);
    expect(filters[0]).toMatchObject({ done: 1, total: 2, memberCount: 2 });
  });
});

describe('task meta helpers', () => {
  it('reads role and http(s) source urls only', () => {
    expect(taskRole(task({ id: '1', title: 'x', meta: { role: 'epic' } }))).toBe('epic');
    expect(taskUrl(task({ id: '2', title: 'x', meta: { url: 'https://github.com/acme/widget/issues/4' } }))).toBe('https://github.com/acme/widget/issues/4');
    expect(taskUrl(task({ id: '3', title: 'x', meta: { url: 'javascript:alert(1)' } }))).toBeNull();
  });
});
