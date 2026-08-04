# AgentForge — Implementation Progress

Running log per implementation-cycle prompt. Newest phase last.

---

## Phase 0 — Scaffold (done)

**Built:**

- pnpm workspaces monorepo: `apps/server` (NestJS 11, entrypoints `main.api.ts` / `main.worker.ts`), `apps/frontend` (Vite 6 + React 19 + `@carbon/react` UIShell), `packages/core` (Zod contracts).
- `packages/core` already carries real contracts, not stubs: the 9-event agent protocol schema (§6.2), the adapter SDK interfaces (§6.1), and the full workflow-definition schema (§7.1) with structural graph validation (single trigger, acyclic, connected, route coverage, per-node edge-condition rules) — tested against the canonical §7.2 workflow.
- Tooling: TS strict everywhere; ESLint 9 flat config with the DDD boundary rules (`contexts/*/domain/**` may not import NestJS/TypeORM/BullMQ/ioredis/pg or outer layers; `application/**` may not import typeorm or infrastructure/interface; `packages/core` framework-free); Prettier; Vitest (server tests via `unplugin-swc` so decorator metadata works); `docker-compose.dev.yml` (Postgres 18 + Redis 7 AOF); `pnpm verify` = build + lint + typecheck + test.
- Frontend renders Carbon UIShell (g100), IBM Plex bundled locally (no CDN).

**Verified (DoD):** `pnpm verify` green; `node dist/main.api.js` serves `GET /api/v1/health` → `{"status":"ok"}`; `node dist/main.worker.js` boots a standalone context and stays alive; PG 18.4 + Redis 7 healthy via dev compose; UIShell render covered by a jsdom test.

**Deviations:**

- **PG 18 volume mount:** the official `postgres:18` image now requires the data volume mounted at `/var/lib/postgresql` (not `/var/lib/postgresql/data` as in design doc §11.1's compose). Applied in `docker-compose.dev.yml`; the production compose in Phase 10 must do the same.
- Carbon packages' `ibmtelemetry` postinstall scripts are deliberately not approved in pnpm — aligns with the no-phone-home stance.

**Decisions:**

- Vitest (not Jest) as the single test runner across all packages: one runner, native ESM/TS, `unplugin-swc` supplies decorator metadata for Nest/TypeORM in server tests.
- IBM Plex bundled by disabling Carbon's font-face emission (`$css--font-face: false`) and importing `@ibm/plex-sans` / `@ibm/plex-mono` package CSS so Vite fingerprints and serves the woff2 files locally.
- `env.ts` is a Zod-parsed environment loader provided through a DI token (`APP_ENV`) — no `@nestjs/config` dependency needed.
- Two DB URLs planned from the start: `DATABASE_URL` (restricted app role — append-only audit tables) and `DATABASE_ADMIN_URL` (migration runner only). The design doc's append-only-grants requirement implies two roles; the migration for Phase 1 creates the app role.

**Open questions:** none blocking.

---

## Phase 1 — Persistence & migrations (done)

**Built:**

- Hand-written SQL migration (`1754300000001-initial-schema`) implementing the full §4 DDL: uuidv7 PKs, `run_status`/`flow_status` enums, partial indexes (`runs_active`, `flow_runs_active`, `outbox_pending`, `run_inputs_pending`), citext emails — plus the Identity tables the doc implies but doesn't spell out (`sessions`, `personal_access_tokens`).
- Append-only enforcement, two lines of defense as specified: (a) grants — app role `agentforge_app` has no UPDATE/DELETE on `run_events`/`outbox_events` except a column-level `UPDATE (dispatched_at)`; (b) triggers — `run_events` fully immutable even for admin; `outbox_events` immutable except `dispatched_at`, DELETE only via `prune_dispatched_outbox(interval)` (SECURITY DEFINER, GUC-guarded).
- Advisory-lock migration runner (`pg_advisory_lock` on a dedicated QueryRunner so lock/unlock share a session), run by api at boot against `DATABASE_ADMIN_URL`.
- SnakeNamingStrategy; TypeORM persistence entities per context `infrastructure/`; repository implementations + domain mappers for all aggregates (Identity, Projects, AgentRegistry, Tasking, Execution, Orchestration).
- Domain aggregates: `Run` and `FlowRun` as behavior-rich state machines (illegal transitions throw domain errors), `Task` lifecycle transition map, app-side UUIDv7 generator.

**Verified (DoD):** testcontainers PG 18 — migrations apply to empty DB and re-run as no-op; UPDATE/DELETE on `run_events` as app role → `permission denied`, as admin → trigger exception; outbox `dispatched_at`-only update rule proven both ways; `prune_dispatched_outbox` works for app role; round-trip tests for every aggregate incl. per-run monotonic `run_events.seq`, citext email lookup, task upsert preserving local status, workflow versioning (`listLatest` returns v2). 26 server tests green.

**Decisions:**

- **Two DB roles.** Migrations run as the owner (`DATABASE_ADMIN_URL`); the app connects as `agentforge_app` (`DATABASE_URL`), created by the first migration with the password taken from `DATABASE_URL` — single source of truth, no extra env var.
- **`dispatched_at` column-grant exception**: §4 says "no UPDATE/DELETE grants" for outbox, §2.4 requires the dispatcher to mark `dispatched_at`; resolved with a column-level grant + a trigger that rejects any other field change.
- **Outbox pruning** (doc: "dispatched rows are pruned after 7 days") is only possible through a SECURITY DEFINER function, keeping direct DELETE blocked even for admin.
- **Extra `runs` columns** beyond §4: `workspace_path` (standalone-run worktree) and `resume_state` (adapter §6.1 `ResumeState` persisted by the orchestrator) — both needed by Phases 4–5; added now to avoid a churn migration.
- **Re-sync never overwrites task status** — `upsertSynced` updates title/body/meta only; board lifecycle is locally owned.
- jsonb entity columns are typed `unknown` at the persistence layer (TypeORM's DeepPartial recursion breaks on recursive `Json`); typed casts live in the repository mappers, which is where translation belongs anyway.

---

## Phase 2 — Identity & Projects (done)

**Built:**

- Local auth: register/login/logout with argon2id password hashing; opaque session tokens (random 32 bytes) stored SHA-256-hashed in `sessions`, HttpOnly SameSite=Lax cookie, 30-day TTL, throttled `last_seen_at` touch.
- PATs: `agf_pat_…` tokens returned exactly once, SHA-256-hashed at rest, Bearer guard, revocation; global `AuthGuard` (cookie first, then Bearer) with `@Public()` opt-out.
- Projects CRUD with ownership enforcement (`getOwned` is the v1 tenancy boundary); write-only secrets: PUT/DELETE/list-keys only, AES-256-GCM (`iv|tag|ciphertext`) via `SecretBox` keyed from `AGENTFORGE_SECRET_KEY`; `SecretProvisioningService` is the worker-side decrypt-to-env path (§8) and is never exposed over HTTP.
- Shared HTTP plumbing: per-route `ZodValidationPipe` (schemas from `packages/core`), RFC 9457 `ProblemDetailsFilter` (all errors → `application/problem+json`), cookie utils.
- OpenAPI 3.1 at `/api/v1/openapi.json` generated from the shared Zod schemas via Zod 4's native `z.toJSONSchema` — no extra dependency.

**Verified (DoD):** full-app e2e against testcontainers PG: register → login → create project → put secret → key listed but value unreadable anywhere in the API → worker-side `SecretBox` decrypts the stored ciphertext; PAT Bearer auth + revocation; 401/400 responses are RFC 9457 with Zod issue paths; logout kills the session. 33 server tests green.

**Decisions:**

- Zod 4's built-in JSON Schema conversion powers the OpenAPI doc (avoids a zod-openapi dependency); the doc is assembled statically in `OpenApiController` and extended per phase.
- `@typescript-eslint/consistent-type-imports` is disabled for `apps/server` only: Nest DI resolves constructor params via `emitDecoratorMetadata`, and type-only imports of injectable classes would break injection at runtime.
- Secret keys constrained to `UPPER_SNAKE_CASE` (they become env var names in sandboxes).
- Dev fallback for `AGENTFORGE_SECRET_KEY` baked into env defaults; Phase 10 compose/wizard must set a real one.
- CSRF: SameSite=Lax now; explicit Origin-check middleware deferred to Phase 10 hardening (noted in §12).

---

## Phase 3 — Event backbone: outbox + BullMQ + reconciliation (done)

**Built:**

- `OutboxWriter.append(em, events)` — same-transaction append (the only legal cross-process effect path); `UnitOfWork.withTx` helper; both provided by a global `OutboxModule`.
- `OutboxDispatcher` (worker): 250ms poll, batch 100, `FOR UPDATE SKIP LOCKED`, drains bursts, enqueues BullMQ jobs with deterministic jobIds, publishes every row on the `agentforge:events` pub/sub channel (SSE wake-ups), marks `dispatched_at` in the same tx.
- Event routing table (`event-routing.ts`): `run.requested`→`run.execute`, `run.finalize_requested`→`run.finalize`, run terminal events→`flow.advance` when `payload.flowRunId` present, `gate.*`/`decision.made`/`flow.advance_requested`→`flow.advance`, `task.sync_requested`/`repo.sync_requested`/`notify.requested`→their queues; notification-only events (e.g. `run.event_appended`) are pub/sub-only.
- BullMQ queue module with the full §5.2 topology and per-queue retry policy (`run.execute` attempts=1 — recovery is reconciliation-shaped, not retry-shaped).
- `ReconciliationService` (boot + every 60s, all against Postgres): re-enqueues execute jobs for queued runs, ticks running flows with no active step, counts stale-lease active runs (recovery behavior lands in Phase 4).
- Worker heartbeat in Redis (transient by design); `/api/v1/health` now reports PG, Redis, heartbeat freshness, and per-queue depths.
- In-process `DomainEventBus` for post-commit same-process reactions.

**Verified (DoD):** integration tests with PG+Redis testcontainers — (a) run+outbox commit/rollback atomically and a crash before dispatch loses nothing (the surviving row dispatches later); (b) `FLUSHALL` then reconciliation re-enqueues from Postgres, and undispatched rows also survive a flush; (c) duplicate dispatch after a simulated crash-between-enqueue-and-mark is a no-op thanks to deterministic jobIds. Manual boot check: api+worker against dev compose → health `ok` with fresh heartbeat and all queues. 38 server tests green.

**Decisions:**

- **Plain `bullmq` instead of `@nestjs/bullmq`**: the wrapper's decorator/processor model assumes one app entrypoint and fights the api/worker split; explicit `Queue`/`Worker` wiring in a small `QueueModule` keeps control (queues stay BullMQ 5 on Redis 7 per the fixed stack). TypeORM 0.3 and BullMQ 5 were also explicitly pinned — pnpm resolves newer majors (typeorm 1.x, bullmq 6.x) by default in 2026.
- **BullMQ 5.81 forbids `:` in custom job ids** — deterministic ids use `__` (e.g. `flow.advance__<flowRunId>__<outboxId>`), semantics unchanged from the doc's `flow.advance:<id>:<seq>` scheme.
- Single pub/sub channel (`agentforge:events`) carrying `{eventType, aggregateType, aggregateId, payload}`; SSE endpoints filter client-side of Redis. Simpler than per-run channels at this scale.
- Worker heartbeat lives in Redis (not PG): it is health telemetry, self-repopulating within 10s — an acceptable transient after a flush.
- A simple hand-rolled `DomainEventBus` instead of `@nestjs/cqrs` — the doc's tier-1 usage (post-commit local reactions) doesn't justify the dependency.

---

## Phase 4 — Execution context: runs, events, SSE (done)

**Built:**

- **RunOrchestrator** (worker): owns a run inside one `run.execute` job — sandbox provisioning, adapter start, normalized event ingestion (Zod-validated at the boundary; unmappable events preserved as `type: raw` with `payload.raw`), 15s lease heartbeat on `lease_at`, input pump (message → `send`, approval → `respondToPermission` + `awaiting_input`→`running`, cancel → `stop`), wall-clock timeout, terminal transitions with outbox events carrying `flowRunId`/`structured` for the future engine.
- **Recovery per §5.4**: reconciliation enqueues time-bucketed recovery jobs for stale-lease active runs; the orchestrator resumes via `adapter.resume` + persisted `resume_state` when the capability exists, otherwise fails honestly with an `orchestrator.crash_recovered` timeline event, preserving the workspace.
- **Sandbox abstraction** as a domain port: `process` driver (child processes, path-escape protection, output caps) and `docker` driver (container per step via docker CLI: workdir bind-mount at /workspace, `--network none` policy, memory/cpu/pids limits, labeled `agentforge.run`); selected by `SANDBOX_DRIVER`.
- **SSE** `GET /runs/:id/events/stream`: durable cursor = `run_events.seq` = SSE event id; `Last-Event-ID` resume; Redis pub/sub as wake-up only (every drain reads Postgres); coalesced re-drains; 25s heartbeat; nginx-friendly headers. Plus `POST /runs`, `GET /runs/:id`, `GET /runs/:id/events?after_seq`, `POST /runs/:id/inputs` (message/approval/cancel via shared discriminated-union schema).
- `RunTxPort` (domain port) implemented by `RunTxOps` (infrastructure): run state + `run_events` + outbox rows in one tx, per-run monotonic seq.
- `AdapterRegistry` + `AgentRegistryModule`; BullMQ consumer registration in `ProcessorsService` (worker-only, own blocking connections).

**Verified (DoD):** e2e with a scripted fake adapter — create run over HTTP → SSE stream → disconnect after 4 events → reconnect with `Last-Event-ID` → combined stream has seqs 1..N with **no gaps and no duplicates**, all nine protocol semantics observed (incl. permission approve while disconnected and mid-run steering that reaches the adapter); cancel input → run `cancelled`; simulated worker crash (active run, stale lease) → reconciliation → non-resumable adapter fails with `orchestrator.crash_recovered`, resumable adapter resumes from its checkpoint and succeeds. 42 server tests green.

**Decisions:**

- The ESLint layer rules forced (correctly) two refactors: sandbox driver interface and `RunTxPort` now live in `domain/` as ports; implementations stay in `infrastructure/`.
- `AgentHandle` gained an optional `getResumeState?(): Json` — the doc's `resume(ctx, state)` needs the orchestrator to have persisted state from somewhere; adapters expose a cheap checkpoint after each event batch. Backward compatible with §6.1.
- Docker driver shells out to the docker CLI instead of adding dockerode: worker image controls the CLI version, `execFile` is auditable, and no new dependency (recorded per working rules). `llm-only` currently degrades to `full` with a loud warning; the proxy sidecar is Phase 10 work.
- Cross-context read `flowRunIdFor(runId)` (execution → flow_steps) is raw SQL inside `RunTxOps`, documented as the seam to revisit when Orchestration lands in Phase 8.
