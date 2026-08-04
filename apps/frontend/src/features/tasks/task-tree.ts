import type { TaskDto } from '@agentforge/core';

/** Hierarchy hints stored in task.meta by sync providers. */
export function taskRole(task: TaskDto): 'epic' | 'task' {
  return task.meta?.role === 'epic' ? 'epic' : 'task';
}

export function parentExternalKey(task: TaskDto): string | null {
  const v = task.meta?.parentExternalKey;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

export interface TaskTreeNode {
  task: TaskDto;
  children: TaskDto[];
  /** True when this node is an epic container (has children and/or role=epic). */
  isEpic: boolean;
}

/**
 * Build a one-level epic → tasks tree for the board.
 * Children attach via meta.parentExternalKey matching the parent's externalKey.
 * Tasks whose parent is missing stay top-level (orphan under broken link).
 */
export function buildTaskTree(tasks: TaskDto[]): TaskTreeNode[] {
  const byExternal = new Map<string, TaskDto>();
  for (const t of tasks) {
    if (t.externalKey) byExternal.set(t.externalKey, t);
  }

  const childIds = new Set<string>();
  const childrenOf = new Map<string, TaskDto[]>();

  for (const t of tasks) {
    const parentKey = parentExternalKey(t);
    if (!parentKey) continue;
    const parent = byExternal.get(parentKey);
    if (!parent || parent.id === t.id) continue;
    childIds.add(t.id);
    const list = childrenOf.get(parent.id) ?? [];
    list.push(t);
    childrenOf.set(parent.id, list);
  }

  const sortByRecency = (a: TaskDto, b: TaskDto) => {
    const byCreated = b.createdAt.localeCompare(a.createdAt);
    return byCreated !== 0 ? byCreated : b.id.localeCompare(a.id);
  };

  for (const list of childrenOf.values()) list.sort(sortByRecency);

  const roots: TaskTreeNode[] = [];
  for (const t of tasks) {
    if (childIds.has(t.id)) continue;
    const children = childrenOf.get(t.id) ?? [];
    const isEpic = taskRole(t) === 'epic' || children.length > 0;
    roots.push({ task: t, children, isEpic });
  }

  // Epics (with or without children) first, then standalone tasks — both newest-first.
  roots.sort((a, b) => {
    if (a.isEpic !== b.isEpic) return a.isEpic ? -1 : 1;
    return sortByRecency(a.task, b.task);
  });

  return roots;
}
