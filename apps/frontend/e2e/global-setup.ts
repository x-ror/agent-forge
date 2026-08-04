import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';

const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const STATE_FILE = path.join(os.tmpdir(), 'agentforge-e2e-state.json');
const children: ChildProcess[] = [];

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'E2E',
      GIT_AUTHOR_EMAIL: 'e2e@test',
      GIT_COMMITTER_NAME: 'E2E',
      GIT_COMMITTER_EMAIL: 'e2e@test',
    },
  });
}

function startChild(command: string, args: string[], env: Record<string, string>, matchReady: RegExp): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: FRONTEND_DIR,
    });
    children.push(child);
    let output = '';
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (matchReady.test(output)) resolve(child);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('exit', (code) => reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${output.slice(-2000)}`)));
    setTimeout(() => reject(new Error(`${command} not ready in 60s\n${output.slice(-2000)}`)), 60_000);
  });
}

async function waitForHttp(url: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* retry */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export default async function globalSetup(): Promise<void> {
  // 1. Infra containers.
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:18').withDatabase('agentforge').withUsername('postgres').withPassword('postgres').start(),
    new RedisContainer('redis:7-alpine').start(),
  ]);
  const adminUrl = pg.getConnectionUri();
  const appUrl = `postgres://agentforge_app:agentforge_app@${pg.getHost()}:${pg.getMappedPort(5432)}/agentforge`;
  const redisUrl = redis.getConnectionUrl();

  // 2. Local "GitHub": a bare repo with an initial commit + TASKS.md checklist.
  const work = mkdtempSync(path.join(os.tmpdir(), 'agentforge-e2e-repo-'));
  git(work, 'init', '-b', 'main');
  writeFileSync(path.join(work, 'README.md'), '# e2e fixture\n');
  writeFileSync(path.join(work, 'TASKS.md'), '# Tasks\n\n- [ ] Add greeting feature\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'initial');
  const barePath = mkdtempSync(path.join(os.tmpdir(), 'agentforge-e2e-remote-')) + '/repo.git';
  git(work, 'clone', '--bare', work, barePath);
  const repoUrl = `file://${barePath}`;

  // 3. Mock LLM on a fixed port.
  await startChild('node', ['e2e/mock-llm-server.mjs', '3199'], {}, /MOCK_LLM_PORT=3199/);
  const llmUrl = 'http://127.0.0.1:3199';

  // 4. api + worker (built server dist), sharing a workspaces dir.
  const workspaces = mkdtempSync(path.join(os.tmpdir(), 'agentforge-e2e-ws-'));
  const serverEnv = {
    DATABASE_URL: appUrl,
    DATABASE_ADMIN_URL: adminUrl,
    REDIS_URL: redisUrl,
    WORKSPACES_DIR: workspaces,
    ARTIFACTS_DIR: path.join(workspaces, 'artifacts'),
    AGENTFORGE_SECRET_KEY: Buffer.from('0123456789abcdef0123456789abcdef').toString('base64'),
    API_PORT: '3001',
    SANDBOX_DRIVER: 'process',
  };
  await startChild('node', ['../server/dist/main.api.js'], serverEnv, /api listening/);
  await startChild('node', ['../server/dist/main.worker.js'], serverEnv, /worker started/);
  await waitForHttp('http://127.0.0.1:3001/api/v1/health');

  // 5. Frontend preview (dist must be built; verify pipeline builds it).
  await startChild('pnpm', ['exec', 'vite', 'preview', '--port', '3100', '--strictPort', '--host', '127.0.0.1'], {}, /3100/);
  await waitForHttp('http://127.0.0.1:3100');

  writeFileSync(
    STATE_FILE,
    JSON.stringify({
      pids: children.map((c) => c.pid),
      containers: { pg: pg.getId(), redis: redis.getId() },
      llmUrl,
      repoUrl,
      barePath,
    }),
  );
  process.env.AGENTFORGE_E2E_LLM_URL = llmUrl;
  process.env.AGENTFORGE_E2E_REPO_URL = repoUrl;
  process.env.AGENTFORGE_E2E_BARE_PATH = barePath;
}
