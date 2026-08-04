/** Compact locale-aware timestamp — no seconds, so table cells never wrap. */
const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' });

export function formatDateTime(value: string | Date): string {
  return formatter.format(typeof value === 'string' ? new Date(value) : value);
}
