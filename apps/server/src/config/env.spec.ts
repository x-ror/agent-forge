import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyEnvFile, loadEnv } from './env';

describe('env file loading', () => {
  it('merges a dotenv file without overriding existing variables', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agentforge-env-'));
    const file = path.join(dir, '.env');
    writeFileSync(file, ['API_PORT=4999', 'REDIS_URL=redis://from-file:6379', '# comment', 'EMPTYOK='].join('\n'));

    const target: NodeJS.ProcessEnv = { REDIS_URL: 'redis://from-real-env:6379' };
    expect(applyEnvFile(file, target)).toBe(true);

    expect(target.API_PORT).toBe('4999'); // file fills the gap
    expect(target.REDIS_URL).toBe('redis://from-real-env:6379'); // real env wins

    const parsed = loadEnv(target);
    expect(parsed.API_PORT).toBe(4999);
    expect(parsed.REDIS_URL).toBe('redis://from-real-env:6379');
  });

  it('is a no-op for missing files', () => {
    const target: NodeJS.ProcessEnv = {};
    expect(applyEnvFile('/nonexistent/agentforge/.env', target)).toBe(false);
    expect(Object.keys(target)).toHaveLength(0);
  });
});
