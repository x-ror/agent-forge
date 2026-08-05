/** Compact locale-aware timestamp — no seconds, so table cells never wrap. */
const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

export function formatDateTime(value: string | Date): string {
  return formatter.format(typeof value === 'string' ? new Date(value) : value);
}

/** Compact elapsed time between two instants: "38s", "2m 14s", "1h 03m". */
export function formatDuration(start: string | Date, end: string | Date | null | undefined): string | null {
  if (!end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** Human label for a task-source kind (raw kinds like `github_issues` are UI-hostile). */
const SOURCE_KIND_LABELS: Record<string, string> = {
  github_issues: 'GitHub issues',
  file: 'tracked file',
  jira: 'Jira',
};

export function sourceKindLabel(kind: string): string {
  return SOURCE_KIND_LABELS[kind] ?? kind;
}
