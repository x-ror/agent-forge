import { Tag } from '@carbon/react';

/** One mapping for every status everywhere (§10.4). */
const COLORS: Record<string, 'blue' | 'green' | 'red' | 'purple' | 'gray' | 'teal' | 'magenta'> = {
  // runs
  queued: 'gray',
  provisioning: 'teal',
  running: 'blue',
  awaiting_input: 'purple',
  finalizing: 'teal',
  succeeded: 'green',
  failed: 'red',
  cancelled: 'gray',
  // tasks
  backlog: 'gray',
  in_flow: 'blue',
  done: 'green',
  archived: 'gray',
  // steps
  skipped: 'gray',
};

export function StatusTag({ status }: { status: string }) {
  return (
    <Tag type={COLORS[status] ?? 'gray'} size="sm" data-status={status}>
      {status}
    </Tag>
  );
}
