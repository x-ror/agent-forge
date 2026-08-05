import { describe, expect, it } from 'vitest';
import { cronIntervalMinutes } from '../../src/worker/sync-scheduler.service';

describe('cronIntervalMinutes', () => {
  it('maps common cron shapes to interval minutes', () => {
    expect(cronIntervalMinutes('*/15 * * * *')).toBe(15);
    expect(cronIntervalMinutes('*/5 * * * *')).toBe(5);
    expect(cronIntervalMinutes('* * * * *')).toBe(1);
    expect(cronIntervalMinutes('0 * * * *')).toBe(60);
    expect(cronIntervalMinutes('30 */6 * * *')).toBe(360);
    expect(cronIntervalMinutes('0 3 * * *')).toBe(1440);
  });

  it('rejects malformed expressions', () => {
    expect(cronIntervalMinutes('nonsense')).toBeNull();
    expect(cronIntervalMinutes('* *')).toBeNull();
  });
});
