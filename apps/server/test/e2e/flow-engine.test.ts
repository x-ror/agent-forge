import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { canonicalWorkflowTemplate } from '@agentforge/core';
import { connectApp } from '../helpers/pg';
import { HttpClient, startTestApp, type TestApp } from '../helpers/app';
import { buildTestWorker, type TestWorker } from '../helpers/worker';
import { FakeAdapter, type ScriptItem } from '../helpers/fake-adapter';
import { AdapterRegistry } from '../../src/contexts/agent-registry/application/adapter-registry';
import { listRemoteBranches, makeLocalRepo, type LocalRepo } from '../helpers/git';

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

const implementScript: ScriptItem[] = [
  { type: 'agent.message', text: 'implementing the task' },
  { writeFile: { path: 'impl.txt', content: 'implementation of auth changes' } },
  { type: 'result', outcome: 'success', summary: 'implemented auth changes' },
];

const triageScript: ScriptItem[] = [
  { type: 'agent.thinking', text: 'assessing risk' },
  {
    type: 'result',
    outcome: 'success',
    summary: 'auth files were touched so this needs scrutiny',
    structured: { route: 'deep', reasoning: 'auth files touched — deep review required' },
  },
];

const reviewerScript: ScriptItem[] = [
  { readFile: { path: 'impl.txt' } },
  { writeFile: { path: 'review-notes.txt', content: 'lgtm with notes' } },
  { type: 'result', outcome: 'success', summary: 'review complete' },
];

const failingScript: ScriptItem[] = [
  { type: 'agent.message', text: 'attempting' },
  { type: 'result', outcome: 'failure', summary: 'could not implement: tests are red' },
];

const hangingResumableScript: ScriptItem[] = [
  { type: 'agent.message', text: 'starting long work' },
  { writeFile: { path: 'partial.txt', content: 'partial work' } },
  { waitForever: true },
  { type: 'result', outcome: 'success', summary: 'finished after resume' },
];

describe('Phase 8 e2e: the workflow engine', () => {
  let testApp: TestApp;
  let http: HttpClient;
  let ds: DataSource;
  let worker: TestWorker;
  let repo: LocalRepo;
  let projectId: string;
  let workflowId: string;

  async function makeTask(title: string): Promise<string> {
    const res = await http.post('/tasks', { projectId, title, body: 'task body text' });
    return (res.body as { id: string }).id;
  }

  async function waitFlow(flowRunId: string, statuses: string[], timeoutMs = 45_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await http.get(`/flow-runs/${flowRunId}`);
      const status = (res.body as { status: string }).status;
      if (statuses.includes(status)) return status;
      if (Date.now() > deadline) {
        const detail = JSON.stringify(res.body, null, 2).slice(0, 2000);
        throw new Error(`timeout waiting for ${statuses}; last=${status}\n${detail}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  beforeAll(async () => {
    testApp = await startTestApp({ AGENTFORGE_SECRET_KEY: TEST_KEY });
    ds = await connectApp(testApp.pg.appUrl);
    repo = makeLocalRepo();
    const workspaces = mkdtempSync(path.join(os.tmpdir(), 'agentforge-flow-ws-'));
    worker = buildTestWorker(ds, testApp.redis.url, testApp.redis.client, {
      WORKSPACES_DIR: workspaces,
      AGENTFORGE_SECRET_KEY: TEST_KEY,
    });
    // "Install" the fake adapters in both entrypoints, like real adapters (§6.5).
    const apiRegistry = testApp.app.get(AdapterRegistry);
    for (const registry of [worker.registry, apiRegistry]) {
      registry.register(new FakeAdapter(implementScript, { id: 'fake-implementer' }));
      registry.register(new FakeAdapter(triageScript, { id: 'fake-triage' }));
      registry.register(new FakeAdapter(reviewerScript, { id: 'fake-reviewer' }));
      registry.register(new FakeAdapter(failingScript, { id: 'fake-failing' }));
      registry.register(new FakeAdapter(hangingResumableScript, { id: 'fake-hanging', resume: true }));
    }
    worker.dispatcher.start();

    http = new HttpClient(testApp.baseUrl);
    await http.post('/auth/register', { email: 'flow@agentforge.local', password: 'password-123' });
    const project = await http.post('/projects', { name: 'flow-project', repoUrl: repo.url });
    projectId = (project.body as { id: string }).id;

    const me = await http.get('/auth/me');
    const userId = (me.body as { userId: string }).userId;
    for (const [name, adapter] of [
      ['Implementer', 'fake-implementer'],
      ['Review Triage', 'fake-triage'],
      ['Reviewer', 'fake-reviewer'],
      ['Failer', 'fake-failing'],
      ['Hanger', 'fake-hanging'],
    ]) {
      await ds.query(`INSERT INTO agents (owner_id, name, adapter) VALUES ($1, $2, $3)`, [userId, name, adapter]);
    }

    const workflow = await http.post('/workflows', {
      projectId,
      name: canonicalWorkflowTemplate.name,
      definition: canonicalWorkflowTemplate.definition,
    });
    if (workflow.status !== 201) throw new Error(JSON.stringify(workflow.body));
    workflowId = (workflow.body as { id: string }).id;
  }, 300_000);

  afterAll(async () => {
    await worker?.stop();
    await ds?.destroy();
    await testApp?.stop();
  });

  it('rejects workflows referencing unknown agents or non-structured decision adapters', async () => {
    const unknownAgent = await http.post('/workflows', {
      projectId,
      name: 'bad-wf',
      definition: {
        nodes: [
          { id: 'start', type: 'trigger.task_selected' },
          { id: 'x', type: 'action.agent', agent: 'DoesNotExist', prompt: 'p' },
        ],
        edges: [{ from: 'start', to: 'x', on: 'succeeded' }],
      },
    });
    expect(unknownAgent.status).toBe(400);
    expect(JSON.stringify(unknownAgent.body)).toContain('DoesNotExist');

    const invalidGraph = await http.post('/workflows', {
      projectId,
      name: 'bad-wf-2',
      definition: { nodes: [{ id: 'a', type: 'action.notify' }], edges: [] },
    });
    expect(invalidGraph.status).toBe(400);
  });

  it('versioning: editing creates version n+1; both versions retrievable', async () => {
    const v2 = await http.post(`/workflows/${workflowId}/versions`, {
      definition: canonicalWorkflowTemplate.definition,
    });
    expect(v2.status).toBe(201);
    expect((v2.body as { version: number }).version).toBe(2);
    const list = await http.get(`/workflows?projectId=${projectId}`);
    const canonical = (list.body as Array<{ name: string; version: number }>).find((w) => w.name === canonicalWorkflowTemplate.name);
    expect(canonical?.version).toBe(2); // list shows latest
    expect(((await http.get(`/workflows/${workflowId}`)).body as { version: number }).version).toBe(1);
  });

  it('runs the canonical flow end-to-end: worktree → implement → triage(deep) → review (same worktree) → PR', async () => {
    const taskId = await makeTask('Add OAuth login');
    const started = await http.post('/flow-runs', { workflowId, taskId });
    expect(started.status).toBe(201);
    const flowRunId = (started.body as { id: string }).id;

    expect(await waitFlow(flowRunId, ['succeeded', 'failed'])).toBe('succeeded');

    const detail = (await http.get(`/flow-runs/${flowRunId}`)).body as {
      context: Record<string, unknown>;
      steps: Array<{ nodeId: string; kind: string; status: string; runId: string | null; decision: { route: string; reasoning: string } | null }>;
    };
    const byNode = new Map(detail.steps.map((s) => [s.nodeId, s]));

    // Step sequence & statuses.
    for (const nodeId of ['start', 'worktree', 'implement', 'triage', 'deep', 'pr']) {
      expect(byNode.get(nodeId)?.status, `step ${nodeId}`).toBe('succeeded');
    }
    expect(byNode.has('light')).toBe(false); // the un-taken route never ran

    // Decision with visible reasoning (§7.3).
    const triage = byNode.get('triage')!;
    expect(triage.kind).toBe('decision');
    expect(triage.decision).toEqual({
      route: 'deep',
      reasoning: 'auth files touched — deep review required',
    });

    // Implement's prompt was templated from the task.
    const implementRun = (await http.get(`/runs/${byNode.get('implement')!.runId}`)).body as {
      taskPrompt: string;
      workspacePath?: string;
    };
    expect(implementRun.taskPrompt).toContain('Add OAuth login');
    expect(implementRun.taskPrompt).toContain('task body text');

    // The reviewer ran IN THE SAME worktree and saw implement's file.
    const reviewEvents = (await http.get(`/runs/${byNode.get('deep')!.runId}/events`)).body as Array<{ type: string; payload: { text?: string } }>;
    const reviewMessage = reviewEvents.find((e) => e.type === 'agent.message' && e.payload.text?.includes('impl.txt'));
    expect(reviewMessage?.payload.text).toContain('implementation of auth changes');

    // Triage prompt included the implement diff summary from the flow context.
    const triageRun = (await http.get(`/runs/${triage.runId}`)).body as { taskPrompt: string };
    expect(triageRun.taskPrompt).toContain('file(s) changed');

    // PR step pushed the branch to the bare remote and recorded it in context.
    const prContext = (detail.context.steps as Record<string, { branch?: string; kind?: string }>).pr!;
    expect(prContext.kind).toBe('pr');
    expect(prContext.branch).toMatch(/^agentforge\//);
    expect(listRemoteBranches(repo)).toContain(prContext.branch!);

    // Task followed the flow to done (§7.3).
    expect(((await http.get(`/tasks/${taskId}`)).body as { status: string }).status).toBe('done');

    // Flow diff endpoint returns the cumulative diff (implement + review files).
    const diff = (await http.get(`/flow-runs/${flowRunId}/diff`)).body as { diff: string };
    expect(diff.diff).toContain('impl.txt');
    expect(diff.diff).toContain('review-notes.txt');
  });

  it('routes failure edges: failing implement → notify; flow + task end failed', async () => {
    const failWorkflow = await http.post('/workflows', {
      projectId,
      name: 'fail-path',
      definition: {
        nodes: [
          { id: 'start', type: 'trigger.task_selected' },
          { id: 'implement', type: 'action.agent', agent: 'Failer', prompt: 'do {{task.title}}' },
          { id: 'done-note', type: 'action.notify', channel: 'log', message: 'ok: {{task.title}}' },
          { id: 'fail-note', type: 'action.notify', channel: 'log', message: 'failed: {{steps.implement.error}}' },
        ],
        edges: [
          { from: 'start', to: 'implement', on: 'succeeded' },
          { from: 'implement', to: 'done-note', on: 'succeeded' },
          { from: 'implement', to: 'fail-note', on: 'failed' },
        ],
      },
    });
    expect(failWorkflow.status).toBe(201);

    const taskId = await makeTask('Doomed task');
    const started = await http.post('/flow-runs', {
      workflowId: (failWorkflow.body as { id: string }).id,
      taskId,
    });
    const flowRunId = (started.body as { id: string }).id;

    expect(await waitFlow(flowRunId, ['succeeded', 'failed'])).toBe('failed');
    const detail = (await http.get(`/flow-runs/${flowRunId}`)).body as {
      steps: Array<{ nodeId: string; status: string }>;
    };
    const byNode = new Map(detail.steps.map((s) => [s.nodeId, s.status]));
    expect(byNode.get('implement')).toBe('failed');
    expect(byNode.get('fail-note')).toBe('succeeded'); // failure path ran
    expect(byNode.has('done-note')).toBe(false);
    expect(((await http.get(`/tasks/${taskId}`)).body as { status: string }).status).toBe('failed');
  });

  it('gate.human pauses the flow (awaiting_input) and approval continues it', async () => {
    const gated = await http.post('/workflows', {
      projectId,
      name: 'gated',
      definition: {
        nodes: [
          { id: 'start', type: 'trigger.task_selected' },
          { id: 'gate', type: 'gate.human', message: 'ship it?' },
          { id: 'note', type: 'action.notify', channel: 'log', message: 'shipped' },
        ],
        edges: [
          { from: 'start', to: 'gate', on: 'approved' as never },
          { from: 'gate', to: 'note', on: 'approved' },
        ],
      },
    });
    // Fix edge condition for start→gate (trigger edges use succeeded).
    expect(gated.status).toBe(400);

    const gatedOk = await http.post('/workflows', {
      projectId,
      name: 'gated',
      definition: {
        nodes: [
          { id: 'start', type: 'trigger.task_selected' },
          { id: 'gate', type: 'gate.human', message: 'ship it?' },
          { id: 'note', type: 'action.notify', channel: 'log', message: 'shipped' },
        ],
        edges: [
          { from: 'start', to: 'gate', on: 'succeeded' },
          { from: 'gate', to: 'note', on: 'approved' },
        ],
      },
    });
    expect(gatedOk.status).toBe(201);

    const taskId = await makeTask('Needs approval');
    const started = await http.post('/flow-runs', {
      workflowId: (gatedOk.body as { id: string }).id,
      taskId,
    });
    const flowRunId = (started.body as { id: string }).id;

    expect(await waitFlow(flowRunId, ['awaiting_input'])).toBe('awaiting_input');
    const gateRes = await http.post(`/flow-runs/${flowRunId}/gate`, { approve: true, note: 'lgtm' });
    expect(gateRes.status).toBe(201);
    expect(await waitFlow(flowRunId, ['succeeded', 'failed'])).toBe('succeeded');

    const detail = (await http.get(`/flow-runs/${flowRunId}`)).body as {
      steps: Array<{ nodeId: string; status: string; decision: { route: string; reasoning: string } | null }>;
    };
    const gate = detail.steps.find((s) => s.nodeId === 'gate')!;
    expect(gate.decision?.route).toBe('approved');
    expect(gate.decision?.reasoning).toBe('lgtm');
  });

  it('gate.quality runs commands in the worktree: pass → succeeded, fail (no fixer) → flow failed', async () => {
    const makeQualityWorkflow = async (name: string, command: string) => {
      const res = await http.post('/workflows', {
        projectId,
        name,
        definition: {
          nodes: [
            { id: 'start', type: 'trigger.task_selected' },
            { id: 'worktree', type: 'action.create_worktree' },
            { id: 'quality', type: 'gate.quality', commands: [command] },
            { id: 'note', type: 'action.notify', channel: 'log', message: 'green' },
          ],
          edges: [
            { from: 'start', to: 'worktree', on: 'succeeded' },
            { from: 'worktree', to: 'quality', on: 'succeeded' },
            { from: 'quality', to: 'note', on: 'succeeded' },
          ],
        },
      });
      expect(res.status).toBe(201);
      return (res.body as { id: string }).id;
    };

    const passId = await makeQualityWorkflow('quality-pass', 'test -f README.md || true');
    const passStart = await http.post('/flow-runs', { workflowId: passId, taskId: await makeTask('Quality pass') });
    const passFlow = (passStart.body as { id: string }).id;
    expect(await waitFlow(passFlow, ['succeeded', 'failed'])).toBe('succeeded');
    const passDetail = (await http.get(`/flow-runs/${passFlow}`)).body as { steps: Array<{ nodeId: string; status: string }> };
    expect(passDetail.steps.find((s) => s.nodeId === 'quality')?.status).toBe('succeeded');

    const failId = await makeQualityWorkflow('quality-fail', 'echo "lint error: broken" && exit 1');
    const failStart = await http.post('/flow-runs', { workflowId: failId, taskId: await makeTask('Quality fail') });
    const failFlow = (failStart.body as { id: string }).id;
    expect(await waitFlow(failFlow, ['succeeded', 'failed'])).toBe('failed');
    const failDetail = (await http.get(`/flow-runs/${failFlow}`)).body as {
      steps: Array<{ nodeId: string; status: string }>;
      context: { steps?: Record<string, { output?: string; error?: string }> };
    };
    expect(failDetail.steps.find((s) => s.nodeId === 'quality')?.status).toBe('failed');
    expect(failDetail.context.steps?.quality?.output).toContain('lint error: broken');
  });

  it('cancelling an agent run does NOT restart it — the flow ends cancelled', async () => {
    const wf = await http.post('/workflows', {
      projectId,
      name: 'cancel-no-restart',
      definition: {
        nodes: [
          { id: 'start', type: 'trigger.task_selected' },
          { id: 'implement', type: 'action.agent', agent: 'Hanger', prompt: 'work on {{task.title}}' },
          { id: 'note', type: 'action.notify', channel: 'log' },
        ],
        edges: [
          { from: 'start', to: 'implement', on: 'succeeded' },
          { from: 'implement', to: 'note', on: 'succeeded' },
        ],
      },
    });
    expect(wf.status).toBe(201);
    const taskId = await makeTask('Stop me');
    const started = await http.post('/flow-runs', { workflowId: (wf.body as { id: string }).id, taskId });
    const flowRunId = (started.body as { id: string }).id;

    // Wait for the implement run to exist and be running, then cancel it.
    let runId: string | null = null;
    for (let i = 0; i < 90 && !runId; i += 1) {
      const detail = (await http.get(`/flow-runs/${flowRunId}`)).body as { steps?: Array<{ nodeId: string; status: string; runId: string | null }> };
      const step = detail.steps?.find((s) => s.nodeId === 'implement');
      if (step?.runId && step.status === 'running') runId = step.runId;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(runId).not.toBeNull();
    const cancel = await http.post(`/runs/${runId}/inputs`, { kind: 'cancel' });
    expect(cancel.status).toBe(201);

    // The user-stopped run must not respawn: flow settles cancelled with
    // exactly one implement attempt, and the task returns to backlog.
    expect(await waitFlow(flowRunId, ['cancelled', 'failed', 'succeeded'])).toBe('cancelled');
    const detail = (await http.get(`/flow-runs/${flowRunId}`)).body as { steps: Array<{ nodeId: string; runId: string | null }> };
    expect(detail.steps.filter((s) => s.nodeId === 'implement')).toHaveLength(1);
    expect(((await http.get(`/tasks/${taskId}`)).body as { status: string }).status).toBe('backlog');
  });

  it('gate rejection fails the flow honestly', async () => {
    const wf = await http.post('/workflows', {
      projectId,
      name: 'gated-reject',
      definition: {
        nodes: [
          { id: 'start', type: 'trigger.task_selected' },
          { id: 'gate', type: 'gate.human' },
          { id: 'yes', type: 'action.notify', channel: 'log' },
          { id: 'no', type: 'action.notify', channel: 'log', message: 'rejected: {{task.title}}' },
        ],
        edges: [
          { from: 'start', to: 'gate', on: 'succeeded' },
          { from: 'gate', to: 'yes', on: 'approved' },
          { from: 'gate', to: 'no', on: 'rejected' },
        ],
      },
    });
    const taskId = await makeTask('Rejected work');
    const started = await http.post('/flow-runs', {
      workflowId: (wf.body as { id: string }).id,
      taskId,
    });
    const flowRunId = (started.body as { id: string }).id;
    await waitFlow(flowRunId, ['awaiting_input']);
    await http.post(`/flow-runs/${flowRunId}/gate`, { approve: false, note: 'not now' });
    expect(await waitFlow(flowRunId, ['succeeded', 'failed'])).toBe('failed');
    const detail = (await http.get(`/flow-runs/${flowRunId}`)).body as {
      steps: Array<{ nodeId: string; status: string }>;
    };
    expect(detail.steps.find((s) => s.nodeId === 'no')?.status).toBe('succeeded');
  });

  it('kill worker mid-flow → restart → the flow resumes and completes (§5.4)', async () => {
    const wf = await http.post('/workflows', {
      projectId,
      name: 'resumable-flow',
      definition: {
        nodes: [
          { id: 'start', type: 'trigger.task_selected' },
          { id: 'worktree', type: 'action.create_worktree' },
          { id: 'implement', type: 'action.agent', agent: 'Hanger', prompt: 'work on {{task.title}}' },
        ],
        edges: [
          { from: 'start', to: 'worktree', on: 'succeeded' },
          { from: 'worktree', to: 'implement', on: 'succeeded' },
        ],
      },
    });
    const taskId = await makeTask('Crash survivor');
    const started = await http.post('/flow-runs', {
      workflowId: (wf.body as { id: string }).id,
      taskId,
    });
    const flowRunId = (started.body as { id: string }).id;

    // Wait until the implement run is live (streaming events, then hanging).
    const deadline = Date.now() + 30_000;
    let implementRunId: string | null = null;
    for (;;) {
      const detail = (await http.get(`/flow-runs/${flowRunId}`)).body as {
        steps?: Array<{ nodeId: string; runId: string | null }>;
      };
      implementRunId = detail.steps?.find((s) => s.nodeId === 'implement')?.runId ?? null;
      if (implementRunId) {
        const run = (await http.get(`/runs/${implementRunId}`)).body as { status: string };
        if (run.status === 'running') break;
      }
      if (Date.now() > deadline) throw new Error('implement run never started');
      await new Promise((r) => setTimeout(r, 300));
    }

    // "Kill" the worker: stop consumers, then age the lease as if time passed.
    await worker.stop();
    await ds.query(`UPDATE runs SET lease_at = now() - interval '10 minutes' WHERE id = $1`, [implementRunId]);

    // "Restart": a fresh worker with the same adapters; reconciliation recovers.
    worker = buildTestWorker(ds, testApp.redis.url, testApp.redis.client, {
      WORKSPACES_DIR: worker.scm.mirrorPath('x').split('/mirrors')[0]!,
      AGENTFORGE_SECRET_KEY: TEST_KEY,
    });
    worker.registry.register(new FakeAdapter(hangingResumableScript, { id: 'fake-hanging', resume: true }));
    worker.dispatcher.start();
    await worker.reconciliation.run();

    expect(await waitFlow(flowRunId, ['succeeded', 'failed'])).toBe('succeeded');
    const runEvents = (await http.get(`/runs/${implementRunId}/events`)).body as Array<{ type: string }>;
    expect(runEvents.some((e) => e.type === 'orchestrator.resumed')).toBe(true);
    expect(runEvents.some((e) => e.type === 'result')).toBe(true);
    expect(((await http.get(`/tasks/${taskId}`)).body as { status: string }).status).toBe('done');
  });
});
