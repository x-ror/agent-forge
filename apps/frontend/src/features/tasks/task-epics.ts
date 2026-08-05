import type { TaskDto } from '@agentforge/core';

/** Hierarchy hints stored in task.meta by sync providers. */
export function taskRole(task: TaskDto): 'epic' | 'task' {
  return task.meta?.role === 'epic' ? 'epic' : 'task';
}

/**
 * Epic memberships of a task (set semantics — a task can be in several
 * epics). Reads meta.parentExternalKeys; falls back to the legacy singular
 * meta.parentExternalKey written before membership became a set.
 */
export function parentKeys(task: TaskDto): string[] {
  const many = task.meta?.parentExternalKeys;
  if (Array.isArray(many)) return many.filter((k): k is string => typeof k === 'string' && k.length > 0);
  const one = task.meta?.parentExternalKey;
  return typeof one === 'string' && one.length > 0 ? [one] : [];
}

/** Source web page for the task (GitHub issue html_url); null for file/manual tasks. */
export function taskUrl(task: TaskDto): string | null {
  const v = task.meta?.url;
  return typeof v === 'string' && /^https?:\/\//.test(v) ? v : null;
}

export interface EpicFilter {
  task: TaskDto;
  /** Members present on the board (open, synced leaves). */
  memberCount: number;
  done: number;
  total: number;
}

/**
 * Leaf work items — what the board lists. Epics are filters, not rows.
 */
export function leafTasks(tasks: TaskDto[], epicKey: string | null): TaskDto[] {
  const leaves = tasks.filter((t) => taskRole(t) !== 'epic');
  if (!epicKey) return leaves;
  return leaves.filter((t) => parentKeys(t).includes(epicKey));
}

/**
 * One filter chip per epic, with progress. Progress prefers the sync-derived
 * meta.subIssues (native GitHub sub-issue summary or body-checkbox counts —
 * both include closed/checked items that are never synced), else falls back
 * to the statuses of the members visible on the board. Epics with the most
 * work come first.
 */
export function buildEpicFilters(tasks: TaskDto[]): EpicFilter[] {
  const filters: EpicFilter[] = [];
  for (const task of tasks) {
    if (taskRole(task) !== 'epic' || !task.externalKey) continue;
    const members = tasks.filter((t) => t !== task && parentKeys(t).includes(task.externalKey!));
    const sub = task.meta?.subIssues as { total?: unknown; completed?: unknown } | undefined;
    if (typeof sub?.total === 'number' && sub.total > 0) {
      filters.push({
        task,
        memberCount: members.length,
        done: typeof sub.completed === 'number' ? sub.completed : 0,
        total: sub.total,
      });
    } else {
      filters.push({
        task,
        memberCount: members.length,
        done: members.filter((m) => m.status === 'done').length,
        total: members.length,
      });
    }
  }
  filters.sort((a, b) => b.total - a.total || a.task.title.localeCompare(b.task.title));
  return filters;
}
