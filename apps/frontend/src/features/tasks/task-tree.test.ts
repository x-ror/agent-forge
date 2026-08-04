import { describe, expect, it } from 'vitest';
import type { TaskDto } from '@agentforge/core';
import { buildTaskTree, epicProgress, parentExternalKey, taskRole } from './task-tree';

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

describe('buildTaskTree', () => {
  it('returns flat roots when there is no hierarchy', () => {
    const a = task({ id: '1', title: 'A', createdAt: '2026-01-02T00:00:00.000Z' });
    const b = task({ id: '2', title: 'B', createdAt: '2026-01-01T00:00:00.000Z' });
    const tree = buildTaskTree([a, b]);
    expect(tree.map((n) => n.task.id)).toEqual(['1', '2']);
    expect(tree.every((n) => n.children.length === 0 && !n.isEpic)).toBe(true);
  });

  it('nests children under their epic parent by externalKey', () => {
    const epic = task({
      id: 'e',
      title: 'Auth',
      externalKey: 'file:TASKS.md:epic:auth',
      meta: { role: 'epic' },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const child = task({
      id: 'c',
      title: 'Login',
      externalKey: 'file:TASKS.md:login',
      meta: { parentExternalKey: 'file:TASKS.md:epic:auth' },
      createdAt: '2026-01-02T00:00:00.000Z',
    });
    const orphan = task({ id: 'o', title: 'Other', createdAt: '2026-01-03T00:00:00.000Z' });

    const tree = buildTaskTree([child, orphan, epic]);
    expect(tree).toHaveLength(2);
    // Roots stay newest-first — the standalone task is newer than the epic.
    expect(tree[0]!.task.id).toBe('o');
    expect(tree[1]!.task.id).toBe('e');
    expect(tree[1]!.isEpic).toBe(true);
    expect(tree[1]!.children.map((c) => c.id)).toEqual(['c']);
  });

  it('treats a parent with children as epic even without role flag', () => {
    const parent = task({ id: 'p1', title: 'Parent', externalKey: 'gh#1' });
    const child = task({
      id: 'c1',
      title: 'Child',
      externalKey: 'gh#2',
      meta: { parentExternalKey: 'gh#1' },
    });
    const tree = buildTaskTree([parent, child]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.isEpic).toBe(true);
    expect(tree[0]!.children).toHaveLength(1);
  });

  it('keeps tasks with missing parents as top-level', () => {
    const child = task({
      id: 'c',
      title: 'Orphan child',
      meta: { parentExternalKey: 'missing-key' },
    });
    const tree = buildTaskTree([child]);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.children).toHaveLength(0);
  });
});

describe('task meta helpers', () => {
  it('reads role and parentExternalKey', () => {
    const t = task({ id: '1', title: 'x', meta: { role: 'epic', parentExternalKey: 'p' } });
    expect(taskRole(t)).toBe('epic');
    expect(parentExternalKey(t)).toBe('p');
  });
});

describe('epicProgress', () => {
  it('prefers the GitHub sub-issue summary (closed sub-issues are not synced)', () => {
    const epic = task({ id: 'e', title: 'Epic', externalKey: 'gh#1', meta: { role: 'epic', subIssues: { total: 5, completed: 3 } } });
    const child = task({ id: 'c', title: 'Child', externalKey: 'gh#2', meta: { parentExternalKey: 'gh#1' } });
    const tree = buildTaskTree([epic, child]);
    expect(epicProgress(tree.find((n) => n.task.id === 'e')!)).toEqual({ done: 3, total: 5 });
  });

  it('falls back to synced children statuses', () => {
    const epic = task({ id: 'e', title: 'Epic', externalKey: 'f:e', meta: { role: 'epic' } });
    const done = task({ id: 'a', title: 'A', externalKey: 'f:a', status: 'done', meta: { parentExternalKey: 'f:e' } });
    const open = task({ id: 'b', title: 'B', externalKey: 'f:b', meta: { parentExternalKey: 'f:e' } });
    const tree = buildTaskTree([epic, done, open]);
    expect(epicProgress(tree.find((n) => n.task.id === 'e')!)).toEqual({ done: 1, total: 2 });
  });

  it('returns null for non-epics and childless epics without a summary', () => {
    const plain = task({ id: 'p', title: 'Plain' });
    const emptyEpic = task({ id: 'e', title: 'Epic', meta: { role: 'epic' } });
    const tree = buildTaskTree([plain, emptyEpic]);
    expect(epicProgress(tree.find((n) => n.task.id === 'p')!)).toBeNull();
    expect(epicProgress(tree.find((n) => n.task.id === 'e')!)).toBeNull();
  });
});
