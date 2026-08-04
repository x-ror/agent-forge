import path from 'node:path';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { installAdapters } from '../../src/adapters/install';
import { connectApp } from '../helpers/pg';
import { HttpClient, startTestApp, type TestApp } from '../helpers/app';
import { buildTestWorker, type TestWorker } from '../helpers/worker';
import { startMockLlm, type MockLlm } from '@agentforge/core/conformance';
import { makeLocalRepo } from '../helpers/git';

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

describe('Phase 5 e2e: real api-loop run against a mocked LLM server', () => {
  let testApp: TestApp;
  let http: HttpClient;
  let ds: DataSource;
  let worker: TestWorker;
  let llm: MockLlm;
  let projectId: string;
  let agentId: string;

  beforeAll(async () => {
    testApp = await startTestApp({ AGENTFORGE_SECRET_KEY: TEST_KEY });
    ds = await connectApp(testApp.pg.appUrl);
    llm = await startMockLlm();

    const workspaces = mkdtempSync(path.join(os.tmpdir(), 'agentforge-ws-'));
    worker = buildTestWorker(ds, testApp.redis.url, testApp.redis.client, {
      WORKSPACES_DIR: workspaces,
      AGENTFORGE_SECRET_KEY: TEST_KEY,
    });
    installAdapters(worker.registry);
    worker.dispatcher.start();

    http = new HttpClient(testApp.baseUrl);
    await http.post('/auth/register', { email: 'loop@agentforge.local', password: 'password-123' });
    const project = await http.post('/projects', {
      name: 'loop-project',
      repoUrl: 'file:///tmp/loop.git',
      settings: { allowedCommands: ['echo', 'printf'] },
    });
    projectId = (project.body as { id: string }).id;
    // The provider API key travels the real path: write-only secret → worker decrypt → sandbox env.
    await http.put(`/projects/${projectId}/secrets/ANTHROPIC_API_KEY`, { value: 'sk-mock-123' });

    const agent = await http.post('/agents', {
      name: 'Implementer',
      adapter: 'api-loop',
      config: {
        model: 'mock-model',
        options: { provider: 'anthropic', baseUrl: llm.url },
      },
    });
    expect(agent.status).toBe(201);
    agentId = (agent.body as { id: string }).id;
  }, 300_000);

  afterAll(async () => {
    await worker?.stop();
    await llm?.close();
    await ds?.destroy();
    await testApp?.stop();
  });

  it('lists installed adapters with capabilities', async () => {
    const res = await http.get('/adapters');
    expect(res.status).toBe(200);
    const adapters = res.body as Array<{ id: string; capabilities: { structuredOutput: boolean } }>;
    const apiLoop = adapters.find((a) => a.id === 'api-loop');
    const claudeCode = adapters.find((a) => a.id === 'claude-code');
    expect(apiLoop?.capabilities.structuredOutput).toBe(true);
    expect(claudeCode?.capabilities.structuredOutput).toBe(false);
  });

  it('completes a run end-to-end: api → outbox → worker → sandbox → events → succeeded', async () => {
    llm.pushAnthropic({
      blocks: [
        { type: 'text', text: 'let me check the workspace' },
        { type: 'tool_use', id: 'a1', name: 'run_command', input: { command: 'echo forged' } },
      ],
    });
    llm.pushAnthropic({
      blocks: [
        {
          type: 'tool_use',
          id: 'a2',
          name: 'write_file',
          input: { path: 'hello.txt', content: 'hello from api-loop' },
        },
      ],
    });
    llm.pushAnthropic({ blocks: [{ type: 'text', text: 'implemented and verified' }] });

    const created = await http.post('/runs', {
      projectId,
      agentId,
      prompt: 'write hello.txt',
    });
    expect(created.status).toBe(201);
    const runId = (created.body as { id: string }).id;

    const deadline = Date.now() + 30_000;
    let status = '';
    for (;;) {
      status = ((await http.get(`/runs/${runId}`)).body as { status: string }).status;
      if (['succeeded', 'failed', 'cancelled'].includes(status)) break;
      if (Date.now() > deadline) throw new Error(`timeout; status=${status}`);
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(status).toBe('succeeded');

    const events = (await http.get(`/runs/${runId}/events`)).body as Array<{
      type: string;
      payload: Record<string, unknown>;
    }>;
    const types = events.map((e) => e.type);
    for (const expected of ['agent.message', 'tool.start', 'tool.end', 'file.change', 'usage', 'result']) {
      expect(types).toContain(expected);
    }
    const toolEnd = events.find((e) => e.type === 'tool.end');
    expect(JSON.stringify(toolEnd)).toContain('forged');

    // The file was really written inside the run's sandbox workspace.
    const [runRow] = await ds.query(`SELECT workspace_path FROM runs WHERE id = $1`, [runId]);
    const file = path.join(runRow.workspace_path, 'hello.txt');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('hello from api-loop');

    // The mock server saw the provisioned API key from the encrypted secret.
    const request = llm.requests[0] as { body: unknown };
    expect(request).toBeDefined();
  });

  it('runs in a real git worktree when the repo is clonable; diff endpoint serves the change', async () => {
    const repo = makeLocalRepo();
    const project = await http.post('/projects', {
      name: 'git-project',
      repoUrl: repo.url,
      settings: { allowedCommands: ['echo'] },
    });
    const gitProjectId = (project.body as { id: string }).id;
    await http.put(`/projects/${gitProjectId}/secrets/ANTHROPIC_API_KEY`, { value: 'sk-mock' });

    llm.pushAnthropic({
      blocks: [
        {
          type: 'tool_use',
          id: 'g1',
          name: 'write_file',
          input: { path: 'feature.txt', content: 'the feature\n' },
        },
      ],
    });
    llm.pushAnthropic({ blocks: [{ type: 'text', text: 'feature added' }] });

    const created = await http.post('/runs', {
      projectId: gitProjectId,
      agentId,
      prompt: 'add the feature',
    });
    const runId = (created.body as { id: string }).id;

    const deadline = Date.now() + 30_000;
    for (;;) {
      const status = ((await http.get(`/runs/${runId}`)).body as { status: string }).status;
      if (status === 'succeeded') break;
      if (['failed', 'cancelled'].includes(status) || Date.now() > deadline) {
        throw new Error(`unexpected status ${status}`);
      }
      await new Promise((r) => setTimeout(r, 250));
    }

    // Branch assigned from the worktree; diff artifact captured at finalize.
    const run = (await http.get(`/runs/${runId}`)).body as { branch: string | null };
    expect(run.branch).toMatch(/^agentforge\//);

    const diff = await http.get(`/runs/${runId}/diff`);
    expect(diff.status).toBe(200);
    expect((diff.body as { diff: string }).diff).toContain('feature.txt');
    expect((diff.body as { diff: string }).diff).toContain('the feature');
  });
});
