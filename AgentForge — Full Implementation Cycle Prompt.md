# AgentForge — Full Implementation Cycle Prompt

> Give this prompt to a coding agent (Claude Code, etc.) together with `agentforge-design.md` (v0.4).
> It is designed for iterative execution: run it once to start, then re-run per phase with "continue with Phase N".

---

## Mission

You are the lead engineer implementing **AgentForge** — an agent-agnostic, local-first web service for orchestrating autonomous coding agents — exactly as specified in the attached technical design document `agentforge-design.md` (v0.4). The design document is the single source of truth for architecture. Where this prompt and the doc disagree, the doc wins. Where the doc is silent, follow the Working Rules below.

## Stack (fixed, do not substitute)

PostgreSQL 18 · NestJS 11 (DDD modular monolith; api + worker as two entrypoints of one codebase) · TypeORM 0.3 (persistence entities in infrastructure layer only) · BullMQ 5 on Redis 7 (+ transactional outbox in Postgres) · React 19 + Vite + `@carbon/react` + `@xyflow/react` + TanStack Query · pnpm workspaces monorepo · Docker Compose for deployment · Zod contracts shared via `packages/core`.

## Architecture invariants (violating any of these = wrong implementation)

1. **Postgres is the single source of truth; Redis is disposable.** Every BullMQ payload is IDs only; every processor re-reads state from Postgres; reconciliation can rebuild all Redis state from Postgres (design doc §5.4).
2. **All cross-process effects go through the transactional outbox** (`outbox_events`, written in the same transaction as the state change; dispatcher polls with `FOR UPDATE SKIP LOCKED`; deterministic `jobId`s; idempotent consumers). No dual-writes to Redis from request handlers — ever.
3. **DDD layering per bounded context** (Identity, Projects, Tasking, AgentRegistry, Execution, Orchestration, Scm, Notifications): `domain/` is pure TS (no NestJS, no TypeORM imports — enforce with an ESLint boundary rule), `application/` holds command/query handlers and sagas, `infrastructure/` holds TypeORM entities + repository implementations + external clients, `interface/` holds controllers and BullMQ processors. Contexts communicate only via events and application-service interfaces.
4. **The adapter protocol is the only path for agent activity** — the 9-event union from doc §6.2, Zod-validated at the adapter boundary. Adapters get no DB access and no Docker socket.
5. **Workflows are data**: versioned JSON DAG validated by the shared Zod schema on both client and server; the engine is a stateless process manager ticked by `flow.advance` jobs.
6. **Append-only audit**: `run_events` and `outbox_events` have no UPDATE/DELETE grants for the app role.
7. **Agents never hold push credentials**; push/PR happens in the Scm context from the worker.
8. **Single public origin**: nginx serves the SPA and proxies `/api/v1` (SSE unbuffered); api/worker/postgres/redis publish no host ports.

## Working rules

- Work in a git repo with conventional commits; one commit (or small series) per completed step, always leaving the build green.
- **Test as you go**: unit tests for domain logic (state machines, engine edge resolution, outbox dispatcher idempotency), integration tests against real Postgres+Redis via testcontainers, one E2E per phase's acceptance criteria. Target: domain and engine logic thoroughly tested; do not chase coverage numbers on controllers.
- After each phase: run the full test suite + lint + typecheck, then write a short `PROGRESS.md` entry (what was built, deviations, open questions) before moving on.
- If the design doc is ambiguous, choose the simplest option consistent with the invariants, record the decision in `PROGRESS.md` under "Decisions", and continue — do not stall.
- Do not add dependencies beyond the fixed stack without recording a justification in `PROGRESS.md`.
- Never weaken an invariant to make a test pass.

---

## Phases

Execute in order. Each phase has a **Definition of Done (DoD)** — do not start the next phase until the current DoD passes.

### Phase 0 — Scaffold
Monorepo: `apps/server` (NestJS, entrypoints `main.api.ts` / `main.worker.ts`), `apps/frontend` (Vite + React + Carbon shell), `packages/core` (Zod schemas, DTO types, adapter SDK skeleton, workflow-definition schema). Tooling: TypeScript strict, ESLint (with the domain-purity boundary rule), Prettier, Vitest/Jest, testcontainers, docker-compose.dev.yml (Postgres 18 + Redis 7), CI script (`pnpm verify` = lint + typecheck + test).
**DoD:** `pnpm verify` green; both server entrypoints boot against dev compose; frontend renders a Carbon UIShell page.

### Phase 1 — Persistence & migrations
TypeORM DataSource, naming strategy, migration runner (advisory-lock-guarded, run by api at boot). Hand-written SQL migrations implementing the full DDL from doc §4 (uuidv7 PKs, enums, partial indexes, append-only grants + triggers for `run_events`/`outbox_events`). Persistence entities + repository implementations for all aggregates, with domain↔persistence mappers.
**DoD:** migrations apply cleanly to empty PG 18; repository round-trip tests pass; attempting UPDATE on `run_events` as app role fails in a test.

### Phase 2 — Identity & Projects
Local auth (register/login/logout, session cookies, argon2), PATs (SHA-256-hashed, Bearer guard), Projects CRUD, write-only secrets (AES-256-GCM via `AGENTFORGE_SECRET_KEY`). Global Zod validation pipe + RFC 9457 exception filter. OpenAPI generation from Zod at `/api/v1/openapi.json`.
**DoD:** E2E: register → login → create project → put secret → secret value unreadable via API but decryptable by a worker-side service test.

### Phase 3 — Event backbone (outbox + BullMQ + reconciliation)
`outbox_events` writer helper (same-tx append), in-process domain event bus, outbox dispatcher (batched poll, `FOR UPDATE SKIP LOCKED`, deterministic jobIds, `dispatched_at` marking), BullMQ module with all queues from doc §5.2, Redis pub/sub publisher for SSE wake-ups, boot-time + periodic reconciliation skeleton, `/api/v1/health` (PG, Redis, worker heartbeat, queue depths).
**DoD:** integration test proves: (a) state+outbox commit atomically and a crash between commit and dispatch loses nothing; (b) `FLUSHALL` on Redis followed by reconciliation re-enqueues pending outbox work; (c) duplicate dispatch is a no-op.

### Phase 4 — Execution context (runs, events, SSE)
Run aggregate with the doc §3.1 state machine, `run_events` append with per-run `seq`, run orchestrator in worker (`run.execute` processor, lease heartbeat on `lease_at`), `run_inputs` (message/approval/cancel), SSE endpoints (`/runs/:id/events/stream`) reading from PG cursor with Redis wake-up, `Last-Event-ID` resume. Sandbox abstraction with **`SANDBOX_DRIVER=process` first** (child process in temp dir); Docker driver (container per step, mounts, network modes, resource limits) second.
**DoD:** E2E with a fake adapter: create run → events stream over SSE → disconnect mid-run → reconnect with `Last-Event-ID` → no gaps, no duplicates; kill the worker mid-run → reconciliation marks it recovered per §5.4.

### Phase 5 — Adapter SDK + `api-loop` + one CLI adapter
Adapter SDK in `packages/core` (interfaces from doc §6.1, event Zod schemas, conformance test kit). `api-loop` reference adapter: provider-agnostic loop (Anthropic + OpenAI-compatible), tools `run_command`/`read_file`/`write_file`/`apply_patch`/`search` via sandbox exec, permission gates honoring `allowed_commands`, transcript-replay resume, structured output for decisions. Then the `claude-code` CLI adapter (headless JSON stream, permission hooks, `--version` handshake, resume). AgentRegistry context: agents CRUD, `/api/v1/adapters` capability listing.
**DoD:** conformance suite passes for both adapters (golden event sequence, permission gate, clean cancellation, structured output for api-loop); a real run against a mocked LLM server completes end-to-end.

### Phase 6 — Scm context (mirrors, worktrees, PR)
Mirror clone + `repo.sync`; per-flow worktree lifecycle (`git worktree add`, branch naming, cleanup with retention); cumulative diff computation (`git diff base_ref`); branch push + PR creation (GitHub first) with worker-held tokens; patch-artifact fallback when no remote.
**DoD:** integration test on a local bare repo: worktree created → file changed by a fake step → diff endpoint returns it → "PR" step pushes branch (to the local bare remote) and records the artifact.

### Phase 7 — Tasking context
`task_sources` CRUD + `task.sync` processor (GitHub Issues first, then file source; Jira as a stub interface), upsert semantics on `(source_id, external_key)`, task board API with keyset pagination, status lifecycle, outcome write-back (comment on issue) as a `Notifications` capability.
**DoD:** sync from a fixture GitHub API (mocked) populates the board; re-sync is idempotent; board updates arrive over SSE.

### Phase 8 — Orchestration (the workflow engine)
Workflow schema in `packages/core` (nodes/edges per doc §7.1, validation: acyclic, connected, one trigger, routes covered, agents exist). Workflows CRUD with versioning (edit = version n+1; runs pin exact version). Flow engine as process manager: `flow.advance` ticks, edge resolution, `flow_steps` insertion, context accumulation, prompt templating (`{{task.title}}`, `{{steps.<id>.*}}`), decision coercion to declared routes with reasoning capture, `gate.human` (flow → `awaiting_input`, gate API), failure edges, timeout auto-fail, task status propagation. Ship the canonical workflow as a seed template.
**DoD:** E2E of the canonical flow with fake adapters: task selected → worktree → implement → triage decides `deep` (reasoning stored) → review in the SAME worktree (test asserts it sees implement's changes) → PR step → flow `succeeded`, task `done`; a failing implement with a failure edge routes to notify; killing the worker mid-flow and restarting resumes correctly.

### Phase 9 — Frontend
Per doc §10: Carbon UIShell + routing + auth screens; Task Board (DataTable, start-workflow flow); Run Detail (virtualized event feed, steering, permission approve/deny via ActionableNotification); Flow Run Timeline (vertical ProgressIndicator, per-step Accordion, decision Toggletip with reasoning, gate Modal); Workflow Canvas (`@xyflow/react`, node palette, inspector panel, client-side validation with the shared schema, save-as-new-version); Diff View (custom, Carbon-tokened, TreeView file list); Settings (projects/agents/sources/schedules/PATs). SSE → TanStack Query cache patching with cursor-based refetch on reconnect. Themes g10/g100; IBM Plex bundled locally.
**DoD:** the canonical flow is fully drivable from the UI against the dev backend: build the workflow on the canvas → sync tasks → start → watch decisions with reasoning → approve a gate → see the diff → see the PR link. Playwright E2E covers this path.

### Phase 10 — Hardening & ship
Production Dockerfiles (server multi-stage, frontend nginx with SSE-safe proxy config), the full docker-compose.yml from doc §11.1, `/setup` first-boot wizard, seed workflow templates, Prometheus metrics (queue depth, outbox lag, run durations, costs), pino structured logging with run/flow correlation, secret redaction pass, rate limiting on auth, README (5-minute quickstart), `SECURITY.md`, backup/restore doc proving the `pg_dump`-only story (restore test: flows resume).
**DoD:** `docker compose up` from a clean machine → wizard → canonical flow succeeds with a real agent; full test suite green; README quickstart verified by following it literally.

---

## Final acceptance (the demo that defines "done")

On a clean machine with only Docker installed:

1. `docker compose up` → open `http://localhost:3000` → complete `/setup` in under 5 minutes.
2. Connect a repo, register two agents (Implementer, Reviewer) + a triage agent on `api-loop`.
3. Sync tasks from GitHub Issues; the board fills.
4. Open the canonical workflow template on the canvas; inspect nodes; save.
5. Start the flow on a real task. Watch: worktree → implementation events streaming live → triage decision **with visible reasoning** → review running in the same worktree → PR opened.
6. Kill the worker container mid-implementation; restart it; the flow resumes or recovers per design §5.4 with an honest timeline entry.
7. `docker compose stop redis && docker compose rm -f redis && docker compose up -d redis` — the system self-heals; no work or history lost.
8. `pg_dump`, destroy everything except the dump + volumes, restore — history, workflows, schedules intact.

If any of these eight steps fails, the implementation is not complete.