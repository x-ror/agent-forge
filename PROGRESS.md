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
