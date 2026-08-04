import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { connectApp } from '../helpers/pg';
import { HttpClient, startTestApp, type TestApp } from '../helpers/app';
import { buildTestWorker, type TestWorker } from '../helpers/worker';
import { FakeAdapter, type ScriptItem } from '../helpers/fake-adapter';
import { collectSse } from '../helpers/sse';
import { uuidv7 } from '../../src/shared/uuidv7';

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

const happyScript: ScriptItem[] = [
  { type: 'agent.message', text: 'starting work' },
  { delayMs: 120 },
  { type: 'agent.thinking', text: 'planning' },
  { type: 'tool.start', tool: 'run_command', detail: { cmd: 'ls' } },
  { type: 'tool.end', tool: 'run_command', ok: true, output: 'README.md' },
  { delayMs: 150 },
  { type: 'file.change', path: 'src/a.ts', diff: '+++' },
  { type: 'usage', tokensIn: 100, tokensOut: 40, costUsd: 0.02 },
  { delayMs: 150 },
  { type: 'permission.request', id: 'perm-1', action: 'run_command', detail: { cmd: 'rm x' } },
  { type: 'agent.message', text: 'wrapping up' },
  { type: 'result', outcome: 'success', summary: 'done all the things' },
];

describe('Phase 4 e2e: execution (runs, SSE, recovery)', () => {
  let testApp: TestApp;
  let http: HttpClient;
  let ds: DataSource;
  let worker: TestWorker;
  let cookie: string;
  let projectId: string;
  let agentId: string;
  let resumableAgentId: string;
  let userId: string;

  beforeAll(async () => {
    testApp = await startTestApp({ AGENTFORGE_SECRET_KEY: TEST_KEY });
    ds = await connectApp(testApp.pg.appUrl);
    const workspaces = mkdtempSync(path.join(os.tmpdir(), 'agentforge-ws-'));
    worker = buildTestWorker(ds, testApp.redis.url, testApp.redis.client, {
      WORKSPACES_DIR: workspaces,
      AGENTFORGE_SECRET_KEY: TEST_KEY,
    });
    worker.registry.register(new FakeAdapter(happyScript, { id: 'fake' }));
    worker.registry.register(new FakeAdapter(happyScript, { id: 'fake-resumable', resume: true }));
    worker.dispatcher.start();

    http = new HttpClient(testApp.baseUrl);
    const reg = await http.post('/auth/register', {
      email: 'exec@agentforge.local',
      password: 'password-123',
    });
    if (reg.status !== 201) throw new Error(`register failed: ${JSON.stringify(reg.body)}`);
    userId = (reg.body as { id: string }).id;
    const project = await http.post('/projects', { name: 'p', repoUrl: 'file:///tmp/x.git' });
    projectId = (project.body as { id: string }).id;

    // Agents CRUD arrives in Phase 5; insert registry rows directly.
    const [agent] = await ds.query(
      `INSERT INTO agents (owner_id, name, adapter) VALUES ($1, 'FakeAgent', 'fake') RETURNING id`,
      [userId],
    );
    agentId = agent.id;
    const [resumable] = await ds.query(
      `INSERT INTO agents (owner_id, name, adapter) VALUES ($1, 'ResumableAgent', 'fake-resumable') RETURNING id`,
      [userId],
    );
    resumableAgentId = resumable.id;
    cookie = http.cookieHeader()!;
  }, 300_000);

  afterAll(async () => {
    await worker?.stop();
    await ds?.destroy();
    await testApp?.stop();
  });

  async function waitForStatus(runId: string, statuses: string[], timeoutMs = 30_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await http.get(`/runs/${runId}`);
      const status = (res.body as { status: string }).status;
      if (statuses.includes(status)) return status;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${statuses}; last=${status}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  it('create run → SSE stream → disconnect → resume with Last-Event-ID: no gaps, no duplicates', async () => {
    const created = await http.post('/runs', {
      projectId,
      agentId,
      prompt: 'implement the widget',
    });
    expect(created.status).toBe(201);
    const runId = (created.body as { id: string }).id;
    const streamUrl = `${testApp.baseUrl}/api/v1/runs/${runId}/events/stream`;

    // Phase A: consume the stream until a few events arrive, then drop it.
    const firstBatch = await collectSse(streamUrl, {
      cookie,
      until: (events) => events.length >= 4,
      timeoutMs: 20_000,
    });
    expect(firstBatch.length).toBeGreaterThanOrEqual(4);
    const lastSeenSeq = firstBatch[firstBatch.length - 1]!.id;

    // While disconnected: approve the permission request when it shows up.
    const approver = (async () => {
      const deadline = Date.now() + 20_000;
      for (;;) {
        const events = (await http.get(`/runs/${runId}/events`)).body as Array<{
          type: string;
          payload: { id?: string };
        }>;
        const perm = events.find((e) => e.type === 'permission.request');
        if (perm) {
          await http.post(`/runs/${runId}/inputs`, {
            kind: 'approval',
            permissionId: perm.payload.id,
            decision: 'allow',
          });
          return;
        }
        if (Date.now() > deadline) throw new Error('permission.request never appeared');
        await new Promise((r) => setTimeout(r, 250));
      }
    })();

    // Also steer with a message mid-run.
    await http.post(`/runs/${runId}/inputs`, { kind: 'message', text: 'prefer small diffs' });

    // Phase B: reconnect with Last-Event-ID and read to completion.
    const secondBatch = await collectSse(streamUrl, {
      cookie,
      lastEventId: lastSeenSeq,
      until: (events) =>
        events.some((e) => (e.data as { type: string }).type === 'orchestrator.status' &&
          ['succeeded', 'failed'].includes(((e.data as { payload: { status: string } }).payload).status)),
      timeoutMs: 30_000,
    });
    await approver;

    expect(await waitForStatus(runId, ['succeeded'])).toBe('succeeded');

    // Continuity: seqs strictly increasing, no overlap, no gaps.
    const allSeqs = [...firstBatch, ...secondBatch].map((e) => e.id);
    const sorted = [...allSeqs].sort((a, b) => a - b);
    expect(new Set(allSeqs).size).toBe(allSeqs.length); // no duplicates
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]).toBe(sorted[i - 1]! + 1); // no gaps
    }
    expect(sorted[0]).toBe(1);

    const types = [...firstBatch, ...secondBatch].map((e) => (e.data as { type: string }).type);
    for (const expected of [
      'agent.message',
      'tool.start',
      'tool.end',
      'file.change',
      'usage',
      'permission.request',
      'user.approval',
      'user.message',
      'result',
    ]) {
      expect(types).toContain(expected);
    }

    // Steering reached the adapter.
    const fake = worker.registry.get('fake') as FakeAdapter;
    expect(fake.handles.some((h) => h.received.some((m) => m.text === 'prefer small diffs'))).toBe(
      true,
    );

    // Usage merged onto the run.
    const run = (await http.get(`/runs/${runId}`)).body as { usage: { tokensIn: number } };
    expect(run.usage.tokensIn).toBe(100);
  });

  it('cancel input stops the run as cancelled', async () => {
    const created = await http.post('/runs', { projectId, agentId, prompt: 'never mind' });
    const runId = (created.body as { id: string }).id;
    await waitForStatus(runId, ['running', 'awaiting_input']);
    await http.post(`/runs/${runId}/inputs`, { kind: 'cancel', reason: 'changed my mind' });
    expect(await waitForStatus(runId, ['cancelled'])).toBe('cancelled');
  });

  it('kill worker mid-run → reconciliation recovers: non-resumable adapter fails honestly', async () => {
    // Simulate the post-crash state directly: an active run with a stale lease.
    const runId = uuidv7();
    await ds.query(
      `INSERT INTO runs (id, project_id, agent_id, status, task_prompt, base_ref, lease_at, started_at)
       VALUES ($1, $2, $3, 'running', 'crashed work', 'main', now() - interval '10 minutes', now())`,
      [runId, projectId, agentId],
    );
    const report = await worker.reconciliation.run();
    expect(report.staleActiveRuns).toBeGreaterThanOrEqual(1);

    expect(await waitForStatus(runId, ['failed'])).toBe('failed');
    const events = (await http.get(`/runs/${runId}/events`)).body as Array<{ type: string }>;
    expect(events.some((e) => e.type === 'orchestrator.crash_recovered')).toBe(true);
    const run = (await http.get(`/runs/${runId}`)).body as { error: string };
    expect(run.error).toContain('crash');
  });

  it('kill worker mid-run → reconciliation resumes when the adapter supports it', async () => {
    const runId = uuidv7();
    // Resume from index 10 of the script: agent.message + result success remain.
    await ds.query(
      `INSERT INTO runs (id, project_id, agent_id, status, task_prompt, base_ref, lease_at, started_at, resume_state)
       VALUES ($1, $2, $3, 'running', 'resumable work', 'main', now() - interval '10 minutes', now(), '{"index": 10}')`,
      [runId, projectId, resumableAgentId],
    );
    await worker.reconciliation.run();
    expect(await waitForStatus(runId, ['succeeded'])).toBe('succeeded');
    const events = (await http.get(`/runs/${runId}/events`)).body as Array<{ type: string }>;
    expect(events.some((e) => e.type === 'orchestrator.resumed')).toBe(true);
    expect(events.some((e) => e.type === 'result')).toBe(true);
  });
});
