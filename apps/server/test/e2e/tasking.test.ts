import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { loadEnv } from '../../src/config/env';
import { NotificationsService } from '../../src/contexts/notifications/application/notifications.service';
import { SecretProvisioningService } from '../../src/contexts/projects/application/projects.service';
import { TypeormProjectRepository, TypeormSecretRepository } from '../../src/contexts/projects/infrastructure/typeorm-repositories';
import { GithubClient } from '../../src/contexts/scm/infrastructure/github-client';
import { GitCli } from '../../src/contexts/scm/infrastructure/git-cli';
import { ScmService } from '../../src/contexts/scm/application/scm.service';
import { TypeormArtifactRepository } from '../../src/contexts/execution/infrastructure/typeorm-repositories';
import { TaskSyncService } from '../../src/contexts/tasking/application/task-sync.service';
import { FileTasksProvider, GithubIssuesProvider, JiraProvider } from '../../src/contexts/tasking/infrastructure/providers';
import { TypeormTaskRepository, TypeormTaskSourceRepository } from '../../src/contexts/tasking/infrastructure/typeorm-repositories';
import { UnitOfWork } from '../../src/database/unit-of-work';
import { SecretBox, type SecretBoxService } from '../../src/shared/crypto/secret-box';
import { OutboxDispatcher } from '../../src/shared/outbox/outbox-dispatcher.service';
import { OutboxWriter } from '../../src/shared/outbox/outbox.writer';
import { QUEUE_CONFIG, QUEUE_NAMES, type QueueName } from '../../src/shared/queue/queues';
import type { QueueMap } from '../../src/shared/queue/queue.module';
import { Queue } from 'bullmq';
import { connectApp } from '../helpers/pg';
import { HttpClient, startTestApp, type TestApp } from '../helpers/app';

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

interface MockIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  labels: Array<{ name: string }>;
  pull_request?: object;
}

describe('Phase 7 e2e: tasking — sync, board, SSE, write-back', () => {
  let testApp: TestApp;
  let http_: HttpClient;
  let ds: DataSource;
  let projectId: string;
  let sourceId: string;
  let ghServer: http.Server;
  let issues: MockIssue[];
  const comments: unknown[] = [];
  let dispatcher: OutboxDispatcher;
  let syncWorker: Worker;
  let queues: QueueMap;
  let notifications: NotificationsService;

  beforeAll(async () => {
    testApp = await startTestApp({ AGENTFORGE_SECRET_KEY: TEST_KEY });
    ds = await connectApp(testApp.pg.appUrl);

    issues = [
      {
        number: 1,
        title: 'Fix login bug',
        body: 'Users cannot log in',
        html_url: 'https://github.com/acme/widget/issues/1',
        labels: [{ name: 'bug' }],
      },
      {
        number: 2,
        title: 'Add dark mode',
        body: 'Please',
        html_url: 'https://github.com/acme/widget/issues/2',
        labels: [],
      },
      {
        number: 3,
        title: 'A pull request, not an issue',
        body: '',
        html_url: 'https://github.com/acme/widget/pull/3',
        labels: [],
        pull_request: {},
      },
    ];
    ghServer = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/repos/acme/widget/issues?')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(issues));
        return;
      }
      if (req.method === 'POST' && /\/repos\/acme\/widget\/issues\/\d+\/comments/.test(req.url ?? '')) {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          comments.push({ url: req.url, body: JSON.parse(body) });
          res.writeHead(201, { 'content-type': 'application/json' });
          res.end('{}');
        });
        return;
      }
      res.writeHead(404);
      res.end('{}');
    });
    await new Promise<void>((r) => ghServer.listen(0, '127.0.0.1', r));
    const ghBase = `http://127.0.0.1:${(ghServer.address() as AddressInfo).port}`;

    http_ = new HttpClient(testApp.baseUrl);
    await http_.post('/auth/register', { email: 'task@agentforge.local', password: 'password-123' });
    const project = await http_.post('/projects', {
      name: 'tasking',
      repoUrl: 'https://github.com/acme/widget.git',
      defaultBranch: 'main', // explicit: the remote is fictional, don't probe it
      settings: { githubApiUrl: ghBase },
    });
    projectId = (project.body as { id: string }).id;
    await http_.put(`/projects/${projectId}/secrets/GITHUB_TOKEN`, { value: 'ghp_tasks' });

    // Worker side: dispatcher + task.sync consumer + notifications.
    const env = { ...loadEnv(), AGENTFORGE_SECRET_KEY: TEST_KEY };
    const queueRecord = {} as Record<QueueName, Queue>;
    for (const name of QUEUE_NAMES) {
      queueRecord[name] = new Queue(name, {
        connection: testApp.redis.client,
        defaultJobOptions: QUEUE_CONFIG[name].defaultJobOptions,
      });
    }
    queues = queueRecord as QueueMap;
    dispatcher = new OutboxDispatcher(ds, testApp.redis.client, queues);
    dispatcher.start();

    const secretBox = new SecretBox(TEST_KEY) as SecretBoxService;
    const secretProvisioning = new SecretProvisioningService(new TypeormSecretRepository(ds), secretBox);
    const projectRepo = new TypeormProjectRepository(ds);
    const scm = new ScmService(env, new TypeormArtifactRepository(ds), new GitCli(), new GithubClient(), { token: async () => null }, projectRepo, secretProvisioning);
    const taskSync = new TaskSyncService(
      new TypeormTaskSourceRepository(ds),
      new TypeormTaskRepository(ds),
      projectRepo,
      [new GithubIssuesProvider(), new FileTasksProvider(scm, new GitCli()), new JiraProvider()],
      secretProvisioning,
      new UnitOfWork(ds),
      new OutboxWriter(),
    );
    syncWorker = new Worker(
      'task.sync',
      async (job) => {
        await taskSync.sync((job.data as { taskSourceId: string }).taskSourceId);
      },
      { connection: new IORedis(testApp.redis.url, { maxRetriesPerRequest: null }), concurrency: 2 },
    );
    notifications = new NotificationsService(projectRepo, new GithubClient(), secretProvisioning);
  }, 300_000);

  afterAll(async () => {
    dispatcher?.stop();
    await syncWorker?.close(true);
    await Promise.all(Object.values(queues ?? {}).map((q: Queue) => q.close()));
    ghServer?.close();
    await ds?.destroy();
    await testApp?.stop();
  });

  async function boardTitles(status?: string): Promise<string[]> {
    const query = status ? `&status=${status}` : '';
    const res = await http_.get(`/tasks?projectId=${projectId}${query}`);
    return (res.body as { tasks: Array<{ title: string }> }).tasks.map((t) => t.title);
  }

  it('sync from a (mocked) GitHub Issues API populates the board; SSE announces it', async () => {
    const created = await http_.post('/task-sources', {
      projectId,
      kind: 'github_issues',
      config: {},
    });
    expect(created.status).toBe(201);
    sourceId = (created.body as { id: string }).id;

    // Connect the board stream BEFORE triggering the sync so the wake-up
    // can't race the subscription.
    const sseRes = await fetch(`${testApp.baseUrl}/api/v1/tasks/stream/${projectId}`, {
      headers: { cookie: http_.cookieHeader()! },
    });
    expect(sseRes.status).toBe(200);
    const sseMessages: string[] = [];
    const reader = sseRes.body!.getReader();
    const rawSse = (async () => {
      const decoder = new TextDecoder();
      const deadline = Date.now() + 12_000;
      let buffer = '';
      let pendingRead: ReturnType<typeof reader.read> | null = null;
      while (Date.now() < deadline && sseMessages.length === 0) {
        pendingRead ??= reader.read();
        const chunk = await Promise.race([pendingRead, new Promise<null>((r) => setTimeout(() => r(null), 300))]);
        if (chunk === null) continue;
        pendingRead = null;
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (line.startsWith('data: ')) sseMessages.push(line.slice(6));
        }
      }
      await reader.cancel().catch(() => undefined);
    })();

    const sync = await http_.post(`/task-sources/${sourceId}/sync`);
    expect(sync.status).toBe(202);

    const deadline = Date.now() + 15_000;
    for (;;) {
      const titles = await boardTitles();
      if (titles.length >= 2) break;
      if (Date.now() > deadline) throw new Error('board never populated');
      await new Promise((r) => setTimeout(r, 250));
    }

    const titles = await boardTitles();
    expect(titles).toContain('Fix login bug');
    expect(titles).toContain('Add dark mode');
    expect(titles).not.toContain('A pull request, not an issue'); // PRs filtered

    await rawSse;
    expect(sseMessages.some((m) => m.includes('task.synced'))).toBe(true);
  });

  it('re-sync is idempotent: refreshes content, preserves local status', async () => {
    // Move issue #1's task into the local lifecycle.
    const board = (await http_.get(`/tasks?projectId=${projectId}`)).body as {
      tasks: Array<{ id: string; title: string }>;
    };
    const loginTask = board.tasks.find((t) => t.title === 'Fix login bug')!;
    const moved = await http_.patch(`/tasks/${loginTask.id}`, { status: 'in_flow' });
    expect(moved.status).toBe(200);

    // Upstream edits the title; re-sync.
    issues[0]!.title = 'Fix login bug (URGENT)';
    await http_.post(`/task-sources/${sourceId}/sync`);
    const deadline = Date.now() + 15_000;
    for (;;) {
      const titles = await boardTitles();
      if (titles.includes('Fix login bug (URGENT)')) break;
      if (Date.now() > deadline) throw new Error('resync never landed');
      await new Promise((r) => setTimeout(r, 250));
    }

    const after = (await http_.get(`/tasks?projectId=${projectId}`)).body as {
      tasks: Array<{ id: string; title: string; status: string }>;
    };
    expect(after.tasks).toHaveLength(2); // no duplicates
    const updated = after.tasks.find((t) => t.id === loginTask.id)!;
    expect(updated.title).toBe('Fix login bug (URGENT)');
    expect(updated.status).toBe('in_flow'); // local lifecycle preserved
  });

  it('rejects illegal status transitions with problem+json', async () => {
    const board = (await http_.get(`/tasks?projectId=${projectId}&status=in_flow`)).body as {
      tasks: Array<{ id: string }>;
    };
    const res = await http_.patch(`/tasks/${board.tasks[0]!.id}`, { status: 'archived' });
    expect(res.status).toBe(400);
    expect((res.body as { detail?: string; title: string }).detail ?? '').toContain('illegal');
  });

  it('manual tasks and keyset pagination work', async () => {
    for (let i = 0; i < 5; i++) {
      await http_.post('/tasks', { projectId, title: `manual ${i}` });
    }
    const page1 = (await http_.get(`/tasks?projectId=${projectId}&limit=3`)).body as {
      tasks: Array<{ id: string }>;
      nextCursor: string | null;
    };
    expect(page1.tasks).toHaveLength(3);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = (await http_.get(`/tasks?projectId=${projectId}&limit=3&cursor=${page1.nextCursor}`)).body as { tasks: Array<{ id: string }> };
    expect(page2.tasks.length).toBeGreaterThanOrEqual(3);
    const ids = new Set([...page1.tasks, ...page2.tasks].map((t) => t.id));
    expect(ids.size).toBe(page1.tasks.length + page2.tasks.length); // no overlap
  });

  it('outcome write-back comments on the source issue (Notifications capability)', async () => {
    await notifications.deliver({
      channel: 'github-comment',
      event: { projectId, issueNumber: 1, body: 'AgentForge: PR opened for this task ✔' },
    });
    expect(comments).toHaveLength(1);
    const comment = comments[0] as { url: string; body: { body: string } };
    expect(comment.url).toContain('/issues/1/comments');
    expect(comment.body.body).toContain('PR opened');
  });
});
