import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_FILE = path.join(os.tmpdir(), 'agentforge-e2e-state.json');

export default async function globalTeardown(): Promise<void> {
  if (!existsSync(STATE_FILE)) return;
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as {
    pids: Array<number | undefined>;
    containers: { pg: string; redis: string };
  };
  for (const pid of state.pids) {
    if (pid) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
  for (const id of [state.containers.pg, state.containers.redis]) {
    try {
      execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
  }
  rmSync(STATE_FILE, { force: true });
}
