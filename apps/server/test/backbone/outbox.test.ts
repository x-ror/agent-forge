import { Queue } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { OutboxDispatcher } from '../../src/shared/outbox/outbox-dispatcher.service';
import { OutboxWriter } from '../../src/shared/outbox/outbox.writer';
import { EventTypes, PUBSUB_CHANNEL } from '../../src/shared/outbox/integration-event';
import { QUEUE_CONFIG, QUEUE_NAMES, type QueueName } from '../../src/shared/queue/queues';
import type { QueueMap } from '../../src/shared/queue/queue.module';
import { ReconciliationService } from '../../src/worker/reconciliation.service';
import { uuidv7 } from '../../src/shared/uuidv7';
import { connectApp, startMigratedPg, type PgTestContext } from '../helpers/pg';
import { startRedis, type RedisTestContext } from '../helpers/redis';

function buildQueues(redis: Redis): QueueMap {
  const map = {} as Record<QueueName, Queue>;
  for (const name of QUEUE_NAMES) {
    map[name] = new Queue(name, {
      connection: redis,
      defaultJobOptions: QUEUE_CONFIG[name].defaultJobOptions,
    });
  }
  return map as QueueMap;
}

describe('Phase 3: outbox + BullMQ + reconciliation', () => {
  let pg: PgTestContext;
  let redisCtx: RedisTestContext;
  let ds: DataSource;
  let queues: QueueMap;
  let dispatcher: OutboxDispatcher;
  let reconciliation: ReconciliationService;
  let projectId: string;
  let agentId: string;

  beforeAll(async () => {
    [pg, redisCtx] = await Promise.all([startMigratedPg(), startRedis()]);
    ds = await connectApp(pg.appUrl);
    queues = buildQueues(redisCtx.client);
    dispatcher = new OutboxDispatcher(ds, redisCtx.client, queues);
    reconciliation = new ReconciliationService(ds, queues);

    const [user] = await ds.query(`INSERT INTO users (email) VALUES ('bb@x.y') RETURNING id`);
    const [project] = await ds.query(`INSERT INTO projects (owner_id, name, repo_url) VALUES ($1,'p','file:///r') RETURNING id`, [user.id]);
    const [agent] = await ds.query(`INSERT INTO agents (owner_id, name, adapter) VALUES ($1,'A','api-loop') RETURNING id`, [user.id]);
    projectId = project.id;
    agentId = agent.id;
  }, 240_000);

  afterAll(async () => {
    await Promise.all(Object.values(queues).map((q) => q.close()));
    await ds?.destroy();
    await pg?.stop();
    await redisCtx?.stop();
  });

  async function insertQueuedRun(): Promise<string> {
    const [run] = await ds.query(`INSERT INTO runs (project_id, agent_id, task_prompt, base_ref) VALUES ($1,$2,'x','main') RETURNING id`, [projectId, agentId]);
    return run.id;
  }

  it('(a) state + outbox commit atomically; a crash before dispatch loses nothing', async () => {
    const writer = new OutboxWriter();

    // Failed tx: neither the run nor the outbox row survive.
    const failingRunId = uuidv7();
    await expect(
      ds.transaction(async (em) => {
        await em.query(`INSERT INTO runs (id, project_id, agent_id, task_prompt, base_ref) VALUES ($1,$2,$3,'x','main')`, [failingRunId, projectId, agentId]);
        await writer.append(em, [
          {
            aggregateType: 'run',
            aggregateId: failingRunId,
            eventType: EventTypes.RunRequested,
            payload: {},
          },
        ]);
        throw new Error('boom before commit');
      }),
    ).rejects.toThrow('boom');
    expect((await ds.query(`SELECT count(*) c FROM runs WHERE id = $1`, [failingRunId]))[0].c).toBe('0');
    expect((await ds.query(`SELECT count(*) c FROM outbox_events WHERE aggregate_id = $1`, [failingRunId]))[0].c).toBe('0');

    // Successful tx commits both; "crash" = dispatcher simply hasn't run yet.
    const runId = uuidv7();
    await ds.transaction(async (em) => {
      await em.query(`INSERT INTO runs (id, project_id, agent_id, task_prompt, base_ref) VALUES ($1,$2,$3,'x','main')`, [runId, projectId, agentId]);
      await writer.append(em, [
        {
          aggregateType: 'run',
          aggregateId: runId,
          eventType: EventTypes.RunRequested,
          payload: {},
        },
      ]);
    });

    const pending = await ds.query(`SELECT id FROM outbox_events WHERE aggregate_id = $1 AND dispatched_at IS NULL`, [runId]);
    expect(pending).toHaveLength(1);

    // Dispatcher (post-"restart") turns the surviving row into the job.
    const dispatched = await dispatcher.dispatchOnce();
    expect(dispatched).toBeGreaterThanOrEqual(1);
    const job = await queues['run.execute'].getJob(`run.execute__${runId}`);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({ runId });
    const after = await ds.query(`SELECT dispatched_at FROM outbox_events WHERE aggregate_id = $1`, [runId]);
    expect(after[0].dispatched_at).not.toBeNull();
  });

  it('publishes pub/sub wake-ups for every dispatched row', async () => {
    const subscriber = new IORedis(redisCtx.url, { maxRetriesPerRequest: null });
    await subscriber.subscribe(PUBSUB_CHANNEL);
    const received: string[] = [];
    subscriber.on('message', (_channel, message) => received.push(message));

    const runId = await insertQueuedRun();
    await ds.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('run', $1, 'run.event_appended', '{"seq": 1}')`,
      [runId],
    );
    await dispatcher.dispatchOnce();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await subscriber.quit();

    const messages = received.map((m) => JSON.parse(m) as { aggregateId: string });
    expect(messages.some((m) => m.aggregateId === runId)).toBe(true);
  });

  it('(c) duplicate dispatch of the same row is a no-op (deterministic jobId)', async () => {
    const runId = await insertQueuedRun();
    const [row] = await ds.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('run', $1, 'run.requested', '{}') RETURNING id`,
      [runId],
    );
    await dispatcher.dispatchOnce();
    // Simulate crash-after-enqueue-before-mark: reset dispatched_at (the one
    // column the guard allows) and dispatch again.
    await ds.query(`UPDATE outbox_events SET dispatched_at = NULL WHERE id = $1`, [row.id]);
    await dispatcher.dispatchOnce();

    const jobs = await queues['run.execute'].getJobs(['waiting', 'delayed', 'active', 'completed']);
    const matching = jobs.filter((j) => j.data.runId === runId);
    expect(matching).toHaveLength(1);
  });

  it('(b) FLUSHALL + reconciliation re-enqueues pending work from Postgres', async () => {
    const runId = await insertQueuedRun();
    await ds.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('run', $1, 'run.requested', '{}')`,
      [runId],
    );
    await dispatcher.dispatchOnce();
    expect(await queues['run.execute'].getJob(`run.execute__${runId}`)).toBeDefined();

    // Redis dies completely.
    await redisCtx.client.flushall();
    expect(await queues['run.execute'].getJob(`run.execute__${runId}`)).toBeUndefined();

    // Reconciliation rebuilds queue state from Postgres truth (§5.4).
    const report = await reconciliation.run();
    expect(report.requeuedRuns).toBeGreaterThanOrEqual(1);
    const job = await queues['run.execute'].getJob(`run.execute__${runId}`);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({ runId });
  });

  it('undispatched rows survive a Redis flush and dispatch again (outbox as recovery)', async () => {
    const runId = await insertQueuedRun();
    await ds.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('run', $1, 'run.requested', '{}')`,
      [runId],
    );
    await redisCtx.client.flushall();
    await dispatcher.dispatchOnce();
    expect(await queues['run.execute'].getJob(`run.execute__${runId}`)).toBeDefined();
  });
});
