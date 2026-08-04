import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { createAdminDataSource } from '../../src/database/data-source';
import { runMigrations } from '../../src/database/migration-runner';
import { connectApp, startMigratedPg, type PgTestContext } from '../helpers/pg';

describe('migrations & append-only enforcement', () => {
  let pg: PgTestContext;
  let admin: DataSource;
  let app: DataSource;
  let runId: string;

  beforeAll(async () => {
    pg = await startMigratedPg();
    admin = createAdminDataSource(pg.adminUrl);
    await admin.initialize();
    app = await connectApp(pg.appUrl);

    // Seed a user → project → agent → run through the app role.
    const [user] = await app.query(`INSERT INTO users (email) VALUES ('a@b.c') RETURNING id`);
    const [project] = await app.query(`INSERT INTO projects (owner_id, name, repo_url) VALUES ($1, 'p', 'file:///tmp/r') RETURNING id`, [user.id]);
    const [agent] = await app.query(`INSERT INTO agents (owner_id, name, adapter) VALUES ($1, 'Implementer', 'api-loop') RETURNING id`, [user.id]);
    const [run] = await app.query(`INSERT INTO runs (project_id, agent_id, task_prompt, base_ref) VALUES ($1, $2, 'do it', 'main') RETURNING id`, [project.id, agent.id]);
    runId = run.id;
  }, 180_000);

  afterAll(async () => {
    await app?.destroy();
    await admin?.destroy();
    await pg?.stop();
  });

  it('applies cleanly to an empty PG 18 and is idempotent on re-run', async () => {
    const tables: Array<{ table_name: string }> = await admin.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`);
    const names = tables.map((t) => t.table_name);
    for (const expected of [
      'users',
      'sessions',
      'personal_access_tokens',
      'projects',
      'secrets',
      'agents',
      'task_sources',
      'tasks',
      'runs',
      'run_events',
      'run_inputs',
      'artifacts',
      'workflows',
      'flow_runs',
      'flow_steps',
      'schedules',
      'outbox_events',
    ]) {
      expect(names).toContain(expected);
    }
    // Re-running is a no-op (also exercises the advisory lock path).
    await runMigrations(pg.adminUrl);
  });

  it('uses native uuidv7() defaults (time-ordered ids)', async () => {
    const [a] = await admin.query(`INSERT INTO users (email) VALUES ('u1@x.y') RETURNING id`);
    const [b] = await admin.query(`INSERT INTO users (email) VALUES ('u2@x.y') RETURNING id`);
    expect(a.id < b.id).toBe(true); // v7 = lexicographically time-ordered
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('app role can INSERT run_events but UPDATE/DELETE are denied', async () => {
    await app.query(`INSERT INTO run_events (run_id, seq, type, payload) VALUES ($1, 1, 'agent.message', '{"text":"hi"}')`, [runId]);
    await expect(app.query(`UPDATE run_events SET payload = '{}' WHERE run_id = $1`, [runId])).rejects.toThrow(/permission denied/);
    await expect(app.query(`DELETE FROM run_events WHERE run_id = $1`, [runId])).rejects.toThrow(/permission denied/);
  });

  it('even the admin role cannot mutate run_events (trigger)', async () => {
    await expect(admin.query(`UPDATE run_events SET payload = '{}' WHERE run_id = $1`, [runId])).rejects.toThrow(/append-only/);
    await expect(admin.query(`DELETE FROM run_events WHERE run_id = $1`, [runId])).rejects.toThrow(/append-only/);
  });

  it('outbox_events: app may only set dispatched_at; payload is immutable', async () => {
    const [row] = await app.query(
      `INSERT INTO outbox_events (aggregate_type, aggregate_id, event_type, payload)
       VALUES ('run', $1, 'run.succeeded', '{}') RETURNING id`,
      [runId],
    );
    // dispatched_at update allowed (column grant)
    await app.query(`UPDATE outbox_events SET dispatched_at = now() WHERE id = $1`, [row.id]);
    // payload update denied by grant for app…
    await expect(app.query(`UPDATE outbox_events SET payload = '{"x":1}' WHERE id = $1`, [row.id])).rejects.toThrow(/permission denied/);
    // …and by trigger even for admin
    await expect(admin.query(`UPDATE outbox_events SET payload = '{"x":1}' WHERE id = $1`, [row.id])).rejects.toThrow(/immutable/);
    // direct DELETE denied even for admin (must go through prune fn)
    await expect(admin.query(`DELETE FROM outbox_events WHERE id = $1`, [row.id])).rejects.toThrow(/append-only/);
    // the SECURITY DEFINER prune works for the app role
    const [pruned] = await app.query(`SELECT prune_dispatched_outbox('0 seconds') AS n`);
    expect(Number(pruned.n)).toBeGreaterThanOrEqual(1);
  });

  it('app role cannot read the migrations bookkeeping table', async () => {
    await expect(app.query(`SELECT * FROM typeorm_migrations`)).rejects.toThrow(/permission denied/);
  });
});
