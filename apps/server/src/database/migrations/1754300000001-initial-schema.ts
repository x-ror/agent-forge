import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Full DDL from design doc §4 (hand-written SQL, PG-18 first-class:
 * uuidv7() PKs, enums, partial indexes) plus the Identity tables the doc
 * implies (sessions, personal_access_tokens) and the app DB role with
 * append-only grants on run_events / outbox_events.
 */
export class InitialSchema1754300000001 implements MigrationInterface {
  name = 'InitialSchema1754300000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS citext`);

    // ---- Identity ----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE users (
        id            uuid PRIMARY KEY DEFAULT uuidv7(),
        email         citext UNIQUE NOT NULL,
        password_hash text,
        created_at    timestamptz NOT NULL DEFAULT now()
      )`);

    await queryRunner.query(`
      CREATE TABLE sessions (
        id           uuid PRIMARY KEY DEFAULT uuidv7(),
        user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token_hash   text UNIQUE NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        expires_at   timestamptz NOT NULL,
        last_seen_at timestamptz
      )`);
    await queryRunner.query(`CREATE INDEX sessions_by_user ON sessions (user_id)`);

    await queryRunner.query(`
      CREATE TABLE personal_access_tokens (
        id           uuid PRIMARY KEY DEFAULT uuidv7(),
        user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name         text NOT NULL,
        token_hash   text UNIQUE NOT NULL,
        created_at   timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz,
        revoked_at   timestamptz,
        UNIQUE (user_id, name)
      )`);

    // ---- Projects ----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE projects (
        id             uuid PRIMARY KEY DEFAULT uuidv7(),
        owner_id       uuid NOT NULL REFERENCES users(id),
        name           text NOT NULL,
        repo_url       text NOT NULL,
        default_branch text NOT NULL DEFAULT 'main',
        settings       jsonb NOT NULL DEFAULT '{}',
        created_at     timestamptz NOT NULL DEFAULT now()
      )`);

    await queryRunner.query(`
      CREATE TABLE secrets (
        id         uuid PRIMARY KEY DEFAULT uuidv7(),
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        key        text NOT NULL,
        ciphertext bytea NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, key)
      )`);

    // ---- AgentRegistry -----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE agents (
        id         uuid PRIMARY KEY DEFAULT uuidv7(),
        owner_id   uuid NOT NULL REFERENCES users(id),
        name       text NOT NULL,
        adapter    text NOT NULL,
        config     jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (owner_id, name)
      )`);

    // ---- Tasking -----------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE task_sources (
        id             uuid PRIMARY KEY DEFAULT uuidv7(),
        project_id     uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind           text NOT NULL,
        config         jsonb NOT NULL DEFAULT '{}',
        sync_cron      text,
        last_synced_at timestamptz
      )`);

    await queryRunner.query(`
      CREATE TABLE tasks (
        id           uuid PRIMARY KEY DEFAULT uuidv7(),
        project_id   uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_id    uuid REFERENCES task_sources(id) ON DELETE SET NULL,
        external_key text,
        title        text NOT NULL,
        body         text NOT NULL DEFAULT '',
        status       text NOT NULL DEFAULT 'backlog',
        meta         jsonb NOT NULL DEFAULT '{}',
        created_at   timestamptz NOT NULL DEFAULT now(),
        updated_at   timestamptz NOT NULL DEFAULT now(),
        UNIQUE (source_id, external_key)
      )`);
    await queryRunner.query(`CREATE INDEX tasks_board ON tasks (project_id, status, id)`);

    // ---- Execution ---------------------------------------------------------
    await queryRunner.query(`
      CREATE TYPE run_status AS ENUM
        ('queued','provisioning','running','awaiting_input','finalizing','succeeded','failed','cancelled')`);

    await queryRunner.query(`
      CREATE TABLE runs (
        id             uuid PRIMARY KEY DEFAULT uuidv7(),
        project_id     uuid NOT NULL REFERENCES projects(id),
        agent_id       uuid NOT NULL REFERENCES agents(id),
        status         run_status NOT NULL DEFAULT 'queued',
        task_prompt    text NOT NULL,
        base_ref       text NOT NULL,
        branch         text,
        usage          jsonb NOT NULL DEFAULT '{}',
        error          text,
        lease_at       timestamptz,
        workspace_path text,
        resume_state   jsonb,
        created_at     timestamptz NOT NULL DEFAULT now(),
        started_at     timestamptz,
        finished_at    timestamptz
      )`);
    await queryRunner.query(`
      CREATE INDEX runs_active ON runs (status)
        WHERE status IN ('queued','provisioning','running','awaiting_input','finalizing')`);

    await queryRunner.query(`
      CREATE TABLE run_events (
        run_id  uuid NOT NULL REFERENCES runs(id),
        seq     bigint NOT NULL,
        ts      timestamptz NOT NULL DEFAULT now(),
        type    text NOT NULL,
        payload jsonb NOT NULL,
        PRIMARY KEY (run_id, seq)
      )`);

    await queryRunner.query(`
      CREATE TABLE run_inputs (
        id          uuid PRIMARY KEY DEFAULT uuidv7(),
        run_id      uuid NOT NULL REFERENCES runs(id),
        user_id     uuid NOT NULL REFERENCES users(id),
        kind        text NOT NULL,
        payload     jsonb NOT NULL,
        consumed_at timestamptz,
        created_at  timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(
      `CREATE INDEX run_inputs_pending ON run_inputs (run_id, created_at) WHERE consumed_at IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE artifacts (
        id         uuid PRIMARY KEY DEFAULT uuidv7(),
        run_id     uuid NOT NULL REFERENCES runs(id),
        kind       text NOT NULL,
        name       text NOT NULL,
        content    bytea,
        path       text,
        meta       jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    await queryRunner.query(`CREATE INDEX artifacts_by_run ON artifacts (run_id)`);

    // ---- Orchestration -----------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE workflows (
        id         uuid PRIMARY KEY DEFAULT uuidv7(),
        project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name       text NOT NULL,
        version    int  NOT NULL DEFAULT 1,
        definition jsonb NOT NULL,
        enabled    boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (project_id, name, version)
      )`);

    await queryRunner.query(`
      CREATE TYPE flow_status AS ENUM ('running','awaiting_input','succeeded','failed','cancelled')`);

    await queryRunner.query(`
      CREATE TABLE flow_runs (
        id          uuid PRIMARY KEY DEFAULT uuidv7(),
        workflow_id uuid NOT NULL REFERENCES workflows(id),
        task_id     uuid NOT NULL REFERENCES tasks(id),
        status      flow_status NOT NULL DEFAULT 'running',
        context     jsonb NOT NULL DEFAULT '{}',
        started_at  timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      )`);
    await queryRunner.query(`
      CREATE INDEX flow_runs_active ON flow_runs (status)
        WHERE status IN ('running','awaiting_input')`);

    await queryRunner.query(`
      CREATE TABLE flow_steps (
        id          uuid PRIMARY KEY DEFAULT uuidv7(),
        flow_run_id uuid NOT NULL REFERENCES flow_runs(id),
        node_id     text NOT NULL,
        kind        text NOT NULL,
        status      text NOT NULL DEFAULT 'running',
        run_id      uuid REFERENCES runs(id),
        decision    jsonb,
        started_at  timestamptz NOT NULL DEFAULT now(),
        finished_at timestamptz
      )`);
    await queryRunner.query(`CREATE INDEX flow_steps_by_flow ON flow_steps (flow_run_id, started_at)`);

    await queryRunner.query(`
      CREATE TABLE schedules (
        id            uuid PRIMARY KEY DEFAULT uuidv7(),
        project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workflow_id   uuid NOT NULL REFERENCES workflows(id),
        name          text NOT NULL,
        cron          text NOT NULL,
        timezone      text NOT NULL DEFAULT 'UTC',
        enabled       boolean NOT NULL DEFAULT true,
        catch_up      boolean NOT NULL DEFAULT false,
        last_fired_at timestamptz,
        created_at    timestamptz NOT NULL DEFAULT now()
      )`);

    // ---- Outbox ------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        aggregate_type text NOT NULL,
        aggregate_id   uuid NOT NULL,
        event_type     text NOT NULL,
        payload        jsonb NOT NULL,
        created_at     timestamptz NOT NULL DEFAULT now(),
        dispatched_at  timestamptz
      )`);
    await queryRunner.query(
      `CREATE INDEX outbox_pending ON outbox_events (id) WHERE dispatched_at IS NULL`,
    );

    // ---- Append-only enforcement (invariant #6) ----------------------------
    // run_events: immutable, period.
    await queryRunner.query(`
      CREATE FUNCTION run_events_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'run_events is append-only';
      END $$ LANGUAGE plpgsql`);
    await queryRunner.query(`
      CREATE TRIGGER run_events_append_only
        BEFORE UPDATE OR DELETE ON run_events
        FOR EACH ROW EXECUTE FUNCTION run_events_append_only()`);

    // outbox_events: immutable except marking dispatched_at; DELETE only via
    // the SECURITY DEFINER prune function (maintenance, §4 design notes).
    await queryRunner.query(`
      CREATE FUNCTION outbox_events_guard() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'DELETE' THEN
          IF current_setting('agentforge.outbox_prune', true) = 'on' THEN
            RETURN OLD;
          END IF;
          RAISE EXCEPTION 'outbox_events is append-only (prune via prune_dispatched_outbox)';
        END IF;
        IF NEW.id IS DISTINCT FROM OLD.id
           OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
           OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
           OR NEW.event_type IS DISTINCT FROM OLD.event_type
           OR NEW.payload IS DISTINCT FROM OLD.payload
           OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
          RAISE EXCEPTION 'outbox_events rows are immutable except dispatched_at';
        END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await queryRunner.query(`
      CREATE TRIGGER outbox_events_guard
        BEFORE UPDATE OR DELETE ON outbox_events
        FOR EACH ROW EXECUTE FUNCTION outbox_events_guard()`);

    await queryRunner.query(`
      CREATE FUNCTION prune_dispatched_outbox(older_than interval) RETURNS bigint AS $$
      DECLARE deleted bigint;
      BEGIN
        PERFORM set_config('agentforge.outbox_prune', 'on', true);
        DELETE FROM outbox_events
          WHERE dispatched_at IS NOT NULL AND dispatched_at < now() - older_than;
        GET DIAGNOSTICS deleted = ROW_COUNT;
        PERFORM set_config('agentforge.outbox_prune', 'off', true);
        RETURN deleted;
      END $$ LANGUAGE plpgsql SECURITY DEFINER`);

    // ---- App role (restricted grants) --------------------------------------
    const appPassword = InitialSchema1754300000001.appRolePassword();
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'agentforge_app') THEN
          CREATE ROLE agentforge_app LOGIN PASSWORD '${appPassword.replace(/'/g, "''")}';
        END IF;
      END $$`);
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO agentforge_app`);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agentforge_app`,
    );
    await queryRunner.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agentforge_app`,
    );
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentforge_app`,
    );
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO agentforge_app`,
    );
    // Append-only: the app role cannot UPDATE/DELETE audit tables at all —
    // except the single dispatched_at column the dispatcher must set.
    await queryRunner.query(`REVOKE UPDATE, DELETE ON run_events FROM agentforge_app`);
    await queryRunner.query(`REVOKE UPDATE, DELETE ON outbox_events FROM agentforge_app`);
    await queryRunner.query(`GRANT UPDATE (dispatched_at) ON outbox_events TO agentforge_app`);
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION prune_dispatched_outbox(interval) TO agentforge_app`,
    );
    // The migrations bookkeeping table stays admin-only.
    await queryRunner.query(
      `REVOKE ALL ON TABLE typeorm_migrations FROM agentforge_app`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [
      'outbox_events',
      'schedules',
      'flow_steps',
      'flow_runs',
      'workflows',
      'artifacts',
      'run_inputs',
      'run_events',
      'runs',
      'tasks',
      'task_sources',
      'agents',
      'secrets',
      'projects',
      'personal_access_tokens',
      'sessions',
      'users',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
    }
    await queryRunner.query(`DROP FUNCTION IF EXISTS prune_dispatched_outbox(interval)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS outbox_events_guard()`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS run_events_append_only()`);
    await queryRunner.query(`DROP TYPE IF EXISTS flow_status`);
    await queryRunner.query(`DROP TYPE IF EXISTS run_status`);
  }

  /** App-role password comes from DATABASE_URL so there is a single source of truth. */
  private static appRolePassword(): string {
    const url = process.env.DATABASE_URL;
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.password) return decodeURIComponent(parsed.password);
      } catch {
        // fall through to default
      }
    }
    return 'agentforge_app';
  }
}
