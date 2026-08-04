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

---

## Phase 5 — Adapter SDK + api-loop + claude-code (done)

**Built:**

- **SDK extensions** in `packages/core`: `SandboxProcess` + `SandboxHandle.spawn()` (CLI agents need streaming stdio, one-shot `exec` can't provide it), `EventChannel`/`Gate`/`lines` adapter utilities.
- **`api-loop` reference adapter** (§6.4): provider-agnostic loop over raw `fetch` — Anthropic Messages API and OpenAI-compatible chat/completions (a neutral transcript maps to both, so Ollama/vLLM work for the offline path); tools `run_command`/`read_file`/`write_file`/`apply_patch`/`search` via sandbox exec; `allowed_commands` enforced exactly (prefix match; non-matching commands emit `permission.request` and block on the gate); `decide` tool with route-enum schema for structured decisions; transcript-replay resume via `getResumeState()`; mid-run steering queued into the next turn; `file.change` events on writes/patches.
- **`claude-code` CLI adapter** (§6.3): drives the headless stream-json protocol over sandbox `spawn` stdio; maps init/assistant/tool_result/control_request/result to the 9-event union; permission gates ↔ `can_use_tool` control requests with allow/deny control responses; `--version` handshake fails at start; resume via `--resume <sessionId>`; graceful TERM→KILL stop.
- **Conformance kit** at `@agentforge/core/conformance` (Node-only subpath export): `LocalSandbox` (real child processes incl. `spawn`), `collectEvents`, `expectEventOrder`, `makeRunContext`.
- **AgentRegistry context completed**: agents CRUD (`/api/v1/agents`, adapter-installed + name-unique validation) and `/api/v1/adapters` capability listing; `installAdapters()` registers shipped adapters in both entrypoints (worker executes them, api serves capabilities).
- `spawn` implemented in both sandbox drivers (docker via `docker exec -i`).

**Verified (DoD):** conformance suites pass for both adapters — golden event sequence, permission gate (allow runs the tool / deny short-circuits), clean cancellation (stream ends promptly, no result), structured output for api-loop (route enum advertised to the model, `{route, reasoning}` captured), resume for both (transcript replay incl. pre-crash tool exchange / `--resume` session), version-handshake failure, missing-API-key failure. Full-stack e2e: mocked Anthropic server → agent created via API → encrypted `ANTHROPIC_API_KEY` secret provisioned to the sandbox → run succeeds with the expected event log and a file really written in the workspace. 66 tests green.

**Decisions:**

- No provider SDK dependencies: raw `fetch` against both HTTP APIs keeps `packages/core` dependency-free (zod only) and works in any runtime.
- claude-code's mock CLI fixture speaks the real stream-json shapes (init/session_id, control_request/response, result with cost) so the mapping is tested without the actual binary; the `--version` handshake plus conformance keeps the contract honest when the real CLI lands.
- `allowed_commands` semantics: `undefined` = unrestricted (project didn't opt into gating), `[]` = gate everything, else prefix allow-list; `'*'` wildcard supported.
- codex-cli / openhands / aider adapters remain unimplemented (doc lists them as adapter family members; the two shipped ones cover both integration styles — API loop and CLI stdio). Adding one later is exactly the §6.5 checklist.

---

## Phase 6 — Scm context: mirrors, worktrees, PR (done)

**Built:**

- `ScmService` behind domain ports (`GitPort`→`GitCli`, `GithubPort`→`GithubClient`): idempotent `--mirror` clone (staging-dir + rename), `repo.sync` mirror refresh, worktree lifecycle from the mirror (`git worktree add -b agentforge/<name>`, reattach on recovery), cumulative diff (`git add -N` + `git diff <baseRef>` so untracked files count), commit-all snapshotting, worktree removal.
- Push + PR with worker-held tokens: pushes to the explicit repo URL (a `--mirror` clone's `origin` has mirror push semantics we must not inherit), token injected as `x-access-token` for GitHub HTTPS; PR via fetch-based GitHub client (`githubApiUrl` project setting overrides the API base for tests/GHE); patch-artifact fallback (`git format-patch`) whenever the push target is unusable; `pr` artifacts record URL/number/branch.
- Orchestrator integration: standalone runs now provision a real worktree when the repo is clonable (branch recorded on the run), degrade loudly to a plain directory otherwise; finalize commits agent work and stores the cumulative-diff artifact.
- API: `GET /runs/:id/diff` (served from the finalize artifact — the api container has no workspaces volume by design §11.1) and `GET /runs/:id/artifacts`; `repo.sync` BullMQ consumer in the worker.

**Verified (DoD):** integration test on a local bare repo — mirror → worktree → fake step changes files → cumulative diff contains them → push lands `agentforge/task-42` on the bare remote with the changed content → PR flow against a mocked GitHub API (auth header, head/base assertions, `PR #7` artifact) → patch fallback produces a `format-patch` artifact when the remote is unreachable; `repo.sync` pulls upstream commits (negative refspec keeps local work branches safe); e2e: run in a real worktree gets an `agentforge/` branch and `GET /runs/:id/diff` returns the agent's change. 51 server tests green.

**Decisions:**

- Mirror fetch uses `+refs/heads/*:refs/heads/*` with a **negative refspec** `^refs/heads/agentforge/*` and no prune: our work branches live in worktrees (git refuses to fetch into checked-out branches) and may not exist upstream.
- Diffs are served from artifacts, not live worktrees — the api process has no workspaces volume (§11.1); live change visibility comes from streamed `file.change` events.
- Run finalize happens inline in the orchestrator (not via the `run.finalize` queue): retry semantics for commit+diff are simpler inside the run's own job; the queue remains for future PR/notify decoupling.

---

## Phase 7 — Tasking context (done)

**Built:**

- `TaskSourceProvider` port with three implementations: **GitHub Issues** (open issues, label filter, PRs filtered out, `owner/repo#N` external keys, `githubApiUrl` override), **file** (markdown checklist `- [ ]` lines in the repo, read from the mirror via `git show`), **Jira** (stub interface per plan).
- `TaskSyncService` (`task.sync` consumer): fetch → `upsertSynced` on `(source_id, external_key)` → `last_synced_at` + `task.synced` outbox event in one tx. Local board status is never overwritten by re-sync.
- Task sources CRUD + `POST /task-sources/:id/sync` (emits `task.sync_requested`; the dispatcher enqueues — even manual syncs go through the outbox), task board `GET /tasks?projectId&status&cursor` with keyset pagination + `nextCursor`, manual task creation, `PATCH /tasks/:id` with §3.1 transition enforcement (illegal moves → 400 problem+json) and `task.status_changed` outbox events.
- Board SSE at `GET /tasks/stream/:projectId`: stateless wake-up notifications (`task.synced` / `task.status_changed`, project-filtered) — clients refetch the board; no cursor needed since the board is a snapshot, not a log.
- **Notifications context**: `notify.deliver` consumer with channels `log`, `webhook`, and `github-comment` (outcome write-back to the source issue — worker-held token, §12).
- `task.sync` + `notify.deliver` BullMQ consumers registered in the worker.

**Verified (DoD):** e2e with a mocked GitHub API — sync populates the board (2 issues; the PR the issues API also returns is filtered); re-sync after an upstream title edit is idempotent (2 tasks, updated title, locally-moved `in_flow` status preserved); board `task.synced` message arrives over SSE during sync; illegal transition rejected; keyset pagination pages without overlap; `github-comment` write-back posts to `/issues/1/comments` with the token. 79 tests green across packages.

**Decisions:**

- The board SSE is deliberately cursor-less (unlike run streams): it's a wake-up channel over snapshot data; the durable-cursor machinery stays where the data is an append-only log.
- File-source task keys are `file:<path>:<slug(title)>` — retitling a checklist line creates a new task rather than silently rebinding history (recorded; simplest consistent choice).

---

## Phase 8 — Orchestration: the workflow engine (done)

**Built:**

- **FlowEngine** — a stateless process manager ticked by `flow.advance` jobs (§7.3). One tick, inside a single transaction holding a **per-flow advisory lock** (`pg_advisory_xact_lock`, so concurrent ticks serialize): complete agent/decision steps whose runs finished (context merge incl. `diff`, `diff_summary`, `diff_lines` from the run's diff artifact), expire timed-out gates (timeout ⇒ rejection, §3.1 "never hang forever"), resolve edges **to a fixpoint** (immediate steps — triggers, rule decisions, notify — cascade within one tick), start next nodes, settle. External side effects (worktree creation, PR push) run after commit, complete their steps in follow-up transactions, and re-tick.
- All node types execute: triggers (pre-completed at flow start), `action.create_worktree` (shared flow worktree via Scm), `action.agent` / `decision.agent` (runs created in-tick with rendered prompts, `workspacePath` = the shared worktree, `structured` routes for decisions; the run orchestrator then owns them), `decision.rule` (ordered `when` expressions with a tiny `path op literal` evaluator), `gate.human` (step + flow → `awaiting_input`), `action.open_pr` (push + PR/patch via Scm, result into context), `action.notify` (outbox → `notify.deliver`).
- **Decision coercion** (§7.3): structured `{route, reasoning}` validated against declared routes (case-insensitive rescue, unique-mention-in-summary fallback); uncoercible output fails the step honestly with the reasoning recorded.
- **Settlement semantics**: flow succeeds only when nothing is active/startable and nothing failed; any failed step or rejected gate (even when a failure edge handled it) ends the flow `failed` and the task `failed`; cancellation returns the task to `backlog`; otherwise task → `done` (§7.3 task propagation).
- Workflows CRUD with versioning (create = v1, edit = n+1, list shows latest, runs pin their version) and server-side validation on top of the shared schema: referenced agents exist; `decision.agent` nodes must bind adapters declaring `structuredOutput`.
- Flow-runs API: start (one tx: flow + trigger step + task→`in_flow` + advance tick), detail (steps + decisions + context), gate approve/reject, cumulative diff (latest diff artifact among the flow's runs), SSE stream of step/status changes.
- Reconciliation now ticks **every active flow** each pass (minute-bucketed jobIds) — one mechanism covers crash recovery, stalled flows, and gate timeouts.
- Migration 2: `runs.structured` (decision spec through to `RunContext.structured`), artifacts `run_id` nullable + `flow_run_id` for flow-level PR artifacts.

**Verified (DoD):** e2e — the canonical §7.2 flow with fake adapters runs end-to-end: worktree → implement (writes a real file; prompt templated from the task) → triage decides `deep` with reasoning stored on the step → deep review runs **in the same worktree and reads implement's file** (asserted from its event log; `light` never starts) → PR step pushes `agentforge/…` to the bare remote (branch in flow context + on the remote) → flow `succeeded`, task `done`, flow diff has both steps' files. Failure edge: failing implement routes to the notify step, success path never runs, flow+task `failed`. Gates: `awaiting_input` → approve (note stored as reasoning) → `succeeded`; reject → rejected path runs, flow `failed`. Crash: worker stopped mid-implement, lease aged, fresh worker + reconciliation → run resumes (`orchestrator.resumed`), flow completes, task `done`. Invalid workflows (unknown agent, adapter without structuredOutput, broken graph) rejected at save. 91 tests green.

**Decisions (also absorbing the user's toolchain updates):**

- Toolchain moved to **Oxlint + Oxfmt** and latest deps (TypeORM 1.1, BullMQ 6, ioredis 6, TS 7, Vitest 4) by the user; the DDD boundary rules live on in `.oxlintrc.json`. TS 7.0 lacks the compiler API `nest build` needs, so the server builds with plain `tsc -p tsconfig.build.json` (no Nest CLI plugins were in use).
- Gate timeout ⇒ outcome `rejected` (routes to a rejected edge when present, else fails the flow) — auto-fail with an escape hatch.
- The engine's tick is **pure state reconciliation** — the job's `event` field is informational only; every tick is idempotent, which is what makes at-least-once delivery and blanket reconciliation ticks safe.
- `mock-llm` moved into `@agentforge/core/conformance` (TS 7 forbids cross-package rootDir imports; it belongs to the kit anyway).

---

## Phase 9 — Frontend (done)

**Built (per doc §10):**

- **Shell**: Carbon UIShell with header project picker, g10/g100 theme toggle (persisted), logout; React Router; TanStack Query for all server state; auth screen (login/register toggle) gating the app on `/auth/me`.
- **Task Board**: Carbon DataTable with `StatusTag` (single enum→color mapping used everywhere), per-source Sync buttons, manual task modal, Start-workflow modal (workflow dropdown), live board wake-ups over the project SSE stream → cache invalidation.
- **Run Detail**: virtualized event feed (`@tanstack/react-virtual`), per-type event rendering (message/thinking/tool/file/usage/result), permission requests as `ActionableNotification` allow/deny, steering input, cancel, diff tab. SSE per §10.3: messages patch local state, every (re)connect refetches from the durable `after_seq` cursor — a missed message is never assumed.
- **Flow Run Timeline**: step accordion with status icons, kind tags, decision **route badge on the step title** + reasoning `Toggletip` in the body, links into run details, gate `Modal` (approve/reject with note → stored as reasoning), flow diff tab, flow SSE stream → detail refetch.
- **Workflow Canvas**: `@xyflow/react` with Carbon-token BEM node skin (kind-colored borders), node palette dropdown, inspector panel (id/agent/prompt/routes/title/message + edge condition editing), client-side validation with the exact shared schema (`workflowDefinitionSchema` + `validateWorkflowGraph`) surfacing issues in an `InlineNotification` and blocking save, BFS auto-layout, canonical + **gated** template loaders, save-as-new-version for existing workflows.
- **Diff View**: `@git-diff-view/react` (unified/side-by-side switcher, dark/light follows the app theme) wrapped in Carbon chrome — `TreeView` file list with +/- counts, per-file cards; a small splitter breaks multi-file git diffs into per-file sections.
- **Settings**: projects, agents (adapter select from `/adapters`, model, adapter-options JSON), task sources, write-only secrets, PATs (token shown once).
- **Playwright e2e** (the DoD): global setup boots PG+Redis testcontainers, a local bare repo with `TASKS.md`, a scripted mock Anthropic server, the real built api + worker, and `vite preview`; the test then drives the REAL stack through the browser: register → create project → register 3 api-loop agents → store `ANTHROPIC_API_KEY` secret → add file task source → sync board → load the gated template on the canvas → save → start the flow → watch implement/triage (route badge + reasoning toggletip) → deep review runs, light never → approve the human gate with a note → flow `succeeded` → PR branch shown → diff tab shows the agent's file → task `done`. Passes in ~6s.

**Bugs the e2e caught:** the `file` task-source provider never bootstrapped the mirror (only the GitHub provider had been exercised) — now `ensureMirror` runs on fetch.

**Decisions:**

- Diff rendering via **`@git-diff-view/react`** and **BEM-only styling** (no inline styles except the virtualizer's computed transform/height) — both per user direction mid-phase; all component CSS lives in `src/styles/components.scss` under `.af-*` blocks.
- `@tanstack/react-virtual` added for the event feed (justified: §10 requires a virtualized feed; stays in the TanStack family).
- Playwright runs as `pnpm test:e2e` (separate from `pnpm verify` — it needs Docker + a chromium download; CI can opt in).
- The gate-before-PR template ships as a first-class canvas loader, matching the §12 recommendation for externally-triggered flows.
