import type { TaskDto } from '@agentforge/core';

/** Hierarchy hints stored in task.meta by sync providers. */
export function taskRole(task: TaskDto): 'epic' | 'task' {
  return task.meta?.role === 'epic' ? 'epic' : 'task';
}

export function parentExternalKey(task: TaskDto): string | null {
  const v = task.meta?.parentExternalKey;
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Source web page for the task (GitHub issue html_url); null for file/manual tasks. */
export function taskUrl(task: TaskDto): string | null {
  const v = task.meta?.url;
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v : null;
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

  // Newest-first, same as the board query — epics sit wherever recency puts
  // them rather than jumping to the top.
  roots.sort((a, b) => sortByRecency(a.task, b.task));

  return roots;
}

export interface EpicProgress {
  done: number;
  total: number;
}

/**
 * Epic completion for the board row. Prefer GitHub's sub-issue summary when
 * present — it counts closed sub-issues, which are never synced (only open
 * issues are fetched) — else fall back to the synced children's statuses.
 */
export function epicProgress(node: TaskTreeNode): EpicProgress | null {
  if (!node.isEpic) return null;
  const sub = node.task.meta?.subIssues as { total?: unknown; completed?: unknown } | undefined;
  if (typeof sub?.total === 'number' && sub.total > 0) {
    return { done: typeof sub.completed === 'number' ? sub.completed : 0, total: sub.total };
  }
  if (node.children.length === 0) return null;
  return { done: node.children.filter((c) => c.status === 'done').length, total: node.children.length };
}
