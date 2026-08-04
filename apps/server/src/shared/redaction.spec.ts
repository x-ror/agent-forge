import { describe, expect, it } from 'vitest';
import { redactSecrets } from './redaction';

describe('redactSecrets', () => {
  it('scrubs secret values anywhere in the payload', () => {
    const payload = {
      text: 'the key is sk-super-secret-123 ok',
      nested: { output: 'export TOKEN=sk-super-secret-123' },
    };
    const clean = redactSecrets(payload, ['sk-super-secret-123']) as typeof payload;
    expect(clean.text).toBe('the key is [REDACTED] ok');
    expect(clean.nested.output).toBe('export TOKEN=[REDACTED]');
  });

  it('handles values that need JSON escaping', () => {
    const secret = 'pa"ss\nword-long';
    const clean = redactSecrets({ text: `x ${secret} y` }, [secret]) as { text: string };
    expect(clean.text).toBe('x [REDACTED] y');
  });

  it('ignores short values (too collision-prone) and empty lists', () => {
    expect(redactSecrets({ text: 'abc' }, ['abc'])).toEqual({ text: 'abc' });
    expect(redactSecrets({ text: 'abc' }, [])).toEqual({ text: 'abc' });
  });
});
