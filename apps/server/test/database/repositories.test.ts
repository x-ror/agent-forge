import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { TypeormAgentRepository } from '../../src/contexts/agent-registry/infrastructure/typeorm-repositories';
import { TypeormPersonalAccessTokenRepository, TypeormSessionRepository, TypeormUserRepository } from '../../src/contexts/identity/infrastructure/typeorm-repositories';
import { Run } from '../../src/contexts/execution/domain/run';
import { TypeormRunEventRepository, TypeormRunInputRepository, TypeormRunRepository } from '../../src/contexts/execution/infrastructure/typeorm-repositories';
import { FlowRun } from '../../src/contexts/orchestration/domain/flow-run';
import { TypeormFlowRunRepository, TypeormFlowStepRepository, TypeormWorkflowRepository } from '../../src/contexts/orchestration/infrastructure/typeorm-repositories';
import { TypeormProjectRepository, TypeormSecretRepository } from '../../src/contexts/projects/infrastructure/typeorm-repositories';
import { TypeormTaskRepository, TypeormTaskSourceRepository } from '../../src/contexts/tasking/infrastructure/typeorm-repositories';
import { uuidv7 } from '../../src/shared/uuidv7';
import { connectApp, startMigratedPg, type PgTestContext } from '../helpers/pg';

describe('repository round-trips', () => {
  let pg: PgTestContext;
  let ds: DataSource;
  let userId: string;
  let projectId: string;
  let agentId: string;

  beforeAll(async () => {
    pg = await startMigratedPg();
    ds = await connectApp(pg.appUrl);

    const users = new TypeormUserRepository(ds);
    userId = uuidv7();
    await users.insert({ id: userId, email: 'me@local.test', passwordHash: 'h', createdAt: new Date() });

    const projects = new TypeormProjectRepository(ds);
    projectId = uuidv7();
    await projects.insert({
      id: projectId,
      ownerId: userId,
      name: 'demo',
      repoUrl: 'file:///tmp/demo.git',
      defaultBranch: 'main',
      settings: { networkPolicy: 'full' },
      createdAt: new Date(),
    });

    const agents = new TypeormAgentRepository(ds);
    agentId = uuidv7();
    await agents.insert({
      id: agentId,
      ownerId: userId,
      name: 'Implementer',
      adapter: 'api-loop',
      config: { model: 'claude-sonnet-5' },
      createdAt: new Date(),
    });
  }, 180_000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  it('users / sessions / PATs round-trip', async () => {
    const users = new TypeormUserRepository(ds);
    const found = await users.findByEmail('ME@LOCAL.TEST'); // citext: case-insensitive
    expect(found?.id).toBe(userId);

    const sessions = new TypeormSessionRepository(ds);
    const sid = uuidv7();
    await sessions.insert({
      id: sid,
      userId,
      tokenHash: 'sess-hash',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600_000),
      lastSeenAt: null,
    });
    expect((await sessions.findByTokenHash('sess-hash'))?.id).toBe(sid);
    expect(await sessions.deleteExpired(new Date())).toBe(0);

    const pats = new TypeormPersonalAccessTokenRepository(ds);
    const patId = uuidv7();
    await pats.insert({
      id: patId,
      userId,
      name: 'ci',
      tokenHash: 'pat-hash',
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    });
    await pats.revoke(patId, new Date());
    expect((await pats.findByTokenHash('pat-hash'))?.revokedAt).not.toBeNull();
  });

  it('projects & secrets round-trip (upsert overwrites ciphertext)', async () => {
    const secrets = new TypeormSecretRepository(ds);
    await secrets.upsert({
      id: uuidv7(),
      projectId,
      key: 'GITHUB_TOKEN',
      ciphertext: Buffer.from('v1'),
      createdAt: new Date(),
    });
    await secrets.upsert({
      id: uuidv7(),
      projectId,
      key: 'GITHUB_TOKEN',
      ciphertext: Buffer.from('v2'),
      createdAt: new Date(),
    });
    const found = await secrets.find(projectId, 'GITHUB_TOKEN');
    expect(found?.ciphertext.toString()).toBe('v2');
    expect(await secrets.listKeys(projectId)).toEqual(['GITHUB_TOKEN']);
  });

  it('run aggregate round-trips through its state machine', async () => {
    const runs = new TypeormRunRepository(ds);
    const run = Run.create({
      id: uuidv7(),
      projectId,
      agentId,
      taskPrompt: 'implement the thing',
      baseRef: 'main',
    });
    await runs.insert(run);

    run.startProvisioning();
    run.markRunning();
    run.mergeUsage({ tokensIn: 100, tokensOut: 50, costUsd: 0.01 });
    await runs.save(run);

    const restored = await runs.findById(run.id);
    expect(restored?.status).toBe('running');
    expect(restored?.usage.tokensIn).toBe(100);

    restored!.beginFinalizing();
    restored!.succeed();
    await runs.save(restored!);
    expect((await runs.findById(run.id))?.status).toBe('succeeded');
  });

  it('run events append with per-run monotonic seq', async () => {
    const runs = new TypeormRunRepository(ds);
    const events = new TypeormRunEventRepository(ds);
    const run = Run.create({ id: uuidv7(), projectId, agentId, taskPrompt: 'x', baseRef: 'main' });
    await runs.insert(run);

    const first = await events.append(run.id, [
      { type: 'agent.message', payload: { text: 'one' } },
      { type: 'agent.message', payload: { text: 'two' } },
    ]);
    expect(first.map((e) => e.seq)).toEqual([1, 2]);

    const second = await events.append(run.id, [{ type: 'result', payload: { outcome: 'success' } }]);
    expect(second[0]!.seq).toBe(3);
    expect(await events.lastSeq(run.id)).toBe(3);

    const after1 = await events.listAfter(run.id, 1);
    expect(after1.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('tasks upsert idempotently on (source, external_key) preserving local status', async () => {
    const sources = new TypeormTaskSourceRepository(ds);
    const tasks = new TypeormTaskRepository(ds);
    const sourceId = uuidv7();
    await sources.insert({
      id: sourceId,
      projectId,
      kind: 'github_issues',
      config: { repo: 'o/r' },
      syncCron: '*/15 * * * *',
      lastSyncedAt: null,
    });

    const id1 = await tasks.upsertSynced({
      id: uuidv7(),
      projectId,
      sourceId,
      externalKey: 'o/r#1',
      title: 'first title',
      body: 'b',
      status: 'backlog',
      meta: {},
    });
    // Local lifecycle move…
    const task = await tasks.findById(id1);
    task!.status = 'in_flow';
    await tasks.save(task!);
    // …then re-sync updates content but not status.
    const id2 = await tasks.upsertSynced({
      id: uuidv7(),
      projectId,
      sourceId,
      externalKey: 'o/r#1',
      title: 'updated title',
      body: 'b2',
      status: 'backlog',
      meta: { labels: ['bug'] },
    });
    expect(id2).toBe(id1);
    const after = await tasks.findById(id1);
    expect(after?.title).toBe('updated title');
    expect(after?.status).toBe('in_flow');

    const board = await tasks.listBoard(projectId, { status: 'in_flow' });
    expect(board.some((t) => t.id === id1)).toBe(true);
  });

  it('workflows version and flow runs pin them; steps track decisions', async () => {
    const workflows = new TypeormWorkflowRepository(ds);
    const flowRuns = new TypeormFlowRunRepository(ds);
    const steps = new TypeormFlowStepRepository(ds);
    const tasks = new TypeormTaskRepository(ds);

    const definition = {
      nodes: [{ id: 'start', type: 'trigger.task_selected' as const }],
      edges: [],
    };
    const wfV1 = uuidv7();
    await workflows.insert({
      id: wfV1,
      projectId,
      name: 'canonical',
      version: 1,
      definition,
      enabled: true,
      createdAt: new Date(),
    });
    const wfV2 = uuidv7();
    await workflows.insert({
      id: wfV2,
      projectId,
      name: 'canonical',
      version: 2,
      definition,
      enabled: true,
      createdAt: new Date(),
    });
    const latest = await workflows.findLatestByName(projectId, 'canonical');
    expect(latest?.version).toBe(2);
    expect((await workflows.listLatest(projectId)).map((w) => w.version)).toEqual([2]);

    const taskId = uuidv7();
    await tasks.insert({
      id: taskId,
      projectId,
      sourceId: null,
      externalKey: null,
      title: 'manual task',
      body: '',
      status: 'backlog',
      meta: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const flow = FlowRun.create({ id: uuidv7(), workflowId: wfV1, taskId });
    await flowRuns.insert(flow);
    flow.mergeContext({ worktree: '/data/worktrees/x' });
    flow.awaitInput();
    await flowRuns.save(flow);
    expect((await flowRuns.findById(flow.id))?.status).toBe('awaiting_input');

    const stepId = uuidv7();
    await steps.insert({
      id: stepId,
      flowRunId: flow.id,
      nodeId: 'triage',
      kind: 'decision',
      status: 'running',
      runId: null,
      decision: null,
      startedAt: new Date(),
      finishedAt: null,
    });
    await steps.updateStatus(stepId, 'succeeded', {
      decision: { route: 'deep', reasoning: 'touches auth' },
      finishedAt: new Date(),
    });
    const step = await steps.findById(stepId);
    expect(step?.decision?.route).toBe('deep');
    expect((await steps.listByFlowRun(flow.id)).length).toBe(1);
  });

  it('run inputs queue and consume', async () => {
    const runs = new TypeormRunRepository(ds);
    const inputs = new TypeormRunInputRepository(ds);
    const run = Run.create({ id: uuidv7(), projectId, agentId, taskPrompt: 'y', baseRef: 'main' });
    await runs.insert(run);

    const inputId = uuidv7();
    await inputs.insert({
      id: inputId,
      runId: run.id,
      userId,
      kind: 'message',
      payload: { text: 'focus on tests' },
      consumedAt: null,
      createdAt: new Date(),
    });
    expect((await inputs.pending(run.id)).length).toBe(1);
    await inputs.markConsumed(inputId);
    expect((await inputs.pending(run.id)).length).toBe(0);
  });
});
