import type { ValueTransformer } from 'typeorm';

/** pg returns bigint as string; run_events.seq / outbox id fit safely in JS numbers. */
export const bigintToNumber: ValueTransformer = {
  to: (value?: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};
