/** Compact locale-aware timestamp — no seconds, so table cells never wrap. */
const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

export function formatDateTime(value: string | Date): string {
  return formatter.format(typeof value === 'string' ? new Date(value) : value);
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
