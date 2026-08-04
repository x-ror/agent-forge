# AgentForge — Technical Design Document

**Version:** 0.4 · **Date:** 2026-08-04 · **Status:** Draft for review
*(0.2: NestJS + SvelteKit · 0.3: workflow engine, task sync · 0.4: TypeORM + DDD/event-driven backend, React + Carbon frontend, BullMQ/Redis queues)*

An agent-agnostic, local-first web service for running autonomous coding agents — in the spirit of Devin, but self-hostable and open to any agent runtime. Stack: **PostgreSQL 18** (system of record), **NestJS 11** (API + worker, DDD modular monolith), **TypeORM** (persistence), **BullMQ on Redis** (jobs, cron, pub/sub), **React 19 + Carbon Design System** (frontend).

---

## 1. Overview

### 1.1 What AgentForge is

AgentForge lets a user (or a team) point autonomous coding agents at a repository and supervise their work through a web UI: live event stream, diffs, decisions, ability to interrupt, steer, and approve.

Beyond single runs, users compose **workflows** on a visual canvas: a directed graph of the agents already registered in the project, wired together with events and decision points. The canonical example (used throughout this doc):

> Sync tasks from GitHub Issues / Jira / a tracked file into the local task board → user picks a task → a git worktree is created → an **implementer** agent works the task → a **triage** agent decides whether the change needs a deep or a light review → the matching **reviewer** agent runs → a PR is opened. The user watches the whole chain — every hand-off, every decision the system made and *why*, and the resulting code changes — on a single timeline.

The two defining constraints:

1. **Agent-agnostic.** The service does not embed one agent. It defines a normalized *run protocol* (start / events / steer / stop) and ships **adapters** that translate it to concrete runtimes:
   - **CLI agents** — Claude Code, Codex CLI, OpenHands, Aider, and anything spawnable as a process driven over stdio/JSON streams.
   - **API-driven agents** — an agent loop implemented inside AgentForge against LLM provider SDKs (Anthropic, OpenAI, local models via an OpenAI-compatible endpoint).
2. **Local-first / self-hostable.** The entire system — frontend, API, workers, database, queue, agent sandboxes — runs on one machine via Docker Compose. Code, credentials, and run history never have to leave the user's machine. A hosted deployment is the *same artifact* with different configuration.

### 1.2 Goals

- One-command self-host: `docker compose up` → working system in under 5 minutes.
- Adding a new agent runtime = writing one adapter module; zero changes to core.
- Durable execution: runs and flows survive process restarts; workers crash-recover from Postgres state.
- Everything auditable: every agent action is an immutable event row; every routing decision records its reasoning; every file change is a git commit in an isolated worktree.
- **Postgres is the single source of truth.** Redis carries only transient queue/pub-sub state and is reconstructible from Postgres at any time (§5.4).

### 1.3 Non-goals (v1)

- Multi-node horizontal scaling of workers (queue semantics already permit it; v1 targets a single host).
- Fine-grained multi-tenancy / org hierarchies; v1 has users and projects.
- Being an IDE. AgentForge supervises agents; it is not an editor.
- Mobile-native apps (the React UI is responsive; that's it).

### 1.4 Reference stack

| Concern | Choice | Notes |
|---|---|---|
| System of record | PostgreSQL 18.x | domain state, event log, outbox, task board |
| API server | NestJS 11.x on Node 22 LTS, TypeScript | DDD modular monolith; REST + SSE |
| Worker runtime | NestJS standalone application context | same codebase as API, second entrypoint |
| Persistence | TypeORM 0.3.x | persistence entities in infrastructure layer; hand-reviewed SQL migrations |
| Jobs / cron / delayed work | BullMQ 5.x on Redis 7.x | `@nestjs/bullmq`; Job Schedulers for cron |
| Realtime fan-out | Redis pub/sub → SSE | durable cursor lives in Postgres (`run_events.seq`) |
| Frontend | React 19 + Carbon Design System (`@carbon/react` v1.x) | Vite SPA, served by nginx with API proxy |
| Workflow canvas | `@xyflow/react` (React Flow) | node editor for the workflow builder |
| Agent sandboxes | Docker containers (one per step) | shared git worktree per flow |
| Auth | session cookies; optional OIDC; PATs for automation | local accounts by default |

---

## 2. Architecture

### 2.1 System diagram

```mermaid
flowchart LR
    subgraph Host["Self-hosted machine (Docker Compose)"]
        FE["frontend (nginx)\nReact 19 + Carbon SPA\nproxy /api/v1 → api"]
        subgraph Api["api (NestJS 11)"]
            API[REST controllers /api/v1]
            SSE[SSE endpoints]
        end
        subgraph Worker["worker (NestJS standalone context)"]
            BQ[BullMQ processors]
            FLOW[Flow engine]
            ORCH[Run orchestrator]
            ADP[Agent adapters]
            OBX[Outbox dispatcher]
        end
        PG[(PostgreSQL 18\nsource of truth)]
        RD[(Redis 7\nBullMQ queues + pub/sub\nephemeral by design)]
        subgraph Sandboxes["Run sandboxes"]
            C1[container: step 'implement'\nclaude-code]
            C2[container: step 'review'\napi-loop]
        end
        WT[[shared git worktree\nper flow run]]
    end
    Browser((Browser)) -->|HTTPS :3000| FE
    FE -->|REST + SSE proxy| API
    API -->|tx: state + outbox| PG
    OBX -->|poll outbox| PG
    OBX -->|enqueue| RD
    BQ -->|consume| RD
    FLOW --> ORCH --> ADP
    ADP --> C1 & C2
    C1 & C2 --- WT
    ORCH -->|append run_events| PG
    ORCH -->|publish wake-up| RD
    SSE -->|subscribe| RD
    SSE -->|read cursor| PG
    C1 -.->|LLM API calls| Internet((LLM providers))
```

### 2.2 Processes

1. **`frontend`** — nginx serving the static React/Carbon SPA and **proxying `/api/v1/*` (including SSE, `proxy_buffering off`) to the api container**. Single public origin on `:3000`: no CORS, one cookie domain. IBM Plex fonts and all assets are bundled — no CDN calls, per local-first.
2. **`api`** — NestJS 11 HTTP application: REST controllers, SSE endpoints, auth guards, Zod validation pipes (schemas shared from `packages/core`). Never executes agents; writes state + outbox rows to Postgres. Stateless.
3. **`worker`** — the same NestJS codebase booted as a standalone application context from a second entrypoint (`main.worker.ts`). Owns BullMQ processors, the outbox dispatcher, the flow engine, run orchestration, adapter lifecycles, and sandbox management. Holds the Docker socket; api and frontend do not.
4. **`postgres`** — PostgreSQL 18. All domain state, the append-only `run_events` log, the `outbox_events` table, tasks, workflows, flow history.
5. **`redis`** — Redis 7 with AOF enabled. Carries BullMQ queues, schedulers, and pub/sub. **Treated as disposable**: if Redis is lost, reconciliation (§5.4) re-enqueues everything from Postgres.
6. **Sandbox containers** — one per agent step, created/destroyed by the worker; all steps of a flow mount the same worktree.

Monorepo: `apps/server` (one NestJS project, entrypoints `main.api.ts` / `main.worker.ts`), `apps/frontend` (React + Vite), `packages/core` (shared contracts: API DTOs, event protocol, workflow definition schema — imported by both server and frontend).

### 2.3 Backend architecture: DDD modular monolith

One NestJS codebase, decomposed into **bounded contexts**, each a Nest module with internal layers. Contexts communicate only via domain events and application-service interfaces — never by reaching into each other's repositories.

| Bounded context | Aggregates / key entities | Responsibility |
|---|---|---|
| **Identity** | User, Session, PersonalAccessToken | authn/authz, PAT hashing |
| **Projects** | Project, Secret | repo config, settings, encrypted secrets |
| **Tasking** | TaskSource, Task | sync from GitHub Issues/Jira/file, task board lifecycle |
| **AgentRegistry** | Agent (config), AdapterDescriptor | registered runtimes, capability discovery |
| **Execution** | Run (aggregate root), RunEvent | one agent run: state machine, event log, usage |
| **Orchestration** | Workflow, FlowRun (aggregate root), FlowStep | the DAG engine: advancing flows, decisions, gates |
| **Scm** | Workspace/Worktree, PullRequest | mirrors, worktrees, branch push, PR creation |
| **Notifications** | Subscription, Delivery | webhooks/email on flow & run outcomes |

Each context follows the same layering:

```
src/contexts/<name>/
  domain/          # aggregates, value objects, domain events, repository INTERFACES — pure TS, no framework imports
  application/     # command & query handlers (use-cases), sagas/process managers
  infrastructure/  # TypeORM persistence entities + repository implementations, external clients (GitHub/Jira, Docker)
  interface/       # REST controllers (api entrypoint), BullMQ processors (worker entrypoint), SSE gateways
```

- **Domain purity:** TypeORM decorators never touch domain aggregates. Persistence entities live in `infrastructure/` and are mapped to/from domain objects by the repository implementation. The domain layer compiles with zero dependencies beyond `packages/core` types — cheap to unit-test, safe from ORM leakage.
- **CQRS-light:** commands go through application handlers that load aggregates, invoke behavior, persist, and collect domain events. Queries skip the domain entirely — TypeORM query builder straight to read DTOs (the run timeline, task board, and flow history are read-heavy and shape-specific).
- **State machines** (`Run`, `FlowRun`) are aggregate behavior: illegal transitions throw domain errors; the DB enum + trigger is the second line of defense.

### 2.4 Event-driven backbone

Two event tiers, with an explicit bridge:

1. **Domain events** (in-process): aggregates record events (`RunSucceeded`, `DecisionMade`, `TaskSynced`, `GateApproved`) as they mutate. The application handler persists the aggregate **and the events' integration payloads into `outbox_events` in the same transaction**, then publishes the domain events on the in-process event bus (`@nestjs/cqrs`) *after commit* for same-process reactions (cache invalidation, log enrichment).
2. **Integration events** (cross-process, durable): the **outbox dispatcher** in the worker polls `outbox_events` (`FOR UPDATE SKIP LOCKED`, batched, ~250ms cadence) and translates each into its effect: enqueue a BullMQ job (`flow.advance`, `run.finalize`, `notify.deliver`) and/or publish a Redis pub/sub wake-up for SSE. Dispatch marks the row `dispatched_at`; effects are idempotent (jobs carry deterministic `jobId`s like `flow.advance:<flowRunId>:<seq>`), so at-least-once delivery is safe.

Why an outbox at all: with BullMQ, "commit state to Postgres" and "enqueue to Redis" are two systems — a crash between them would drop or orphan work. The outbox restores the atomicity that a same-DB queue would have given for the price of one small table and a poller. It is also the Redis-loss recovery mechanism: undispatched rows simply dispatch again.

**Sagas:** the flow engine (§7) is a process manager in `Orchestration/application` — it reacts to integration events (`run.succeeded`, `decision.made`, `gate.approved`) delivered via `flow.advance` jobs, and issues new commands (`StartStep`, `CompleteFlow`). All orchestration state lives in `flow_runs`/`flow_steps`, never in memory.

### 2.5 Life of a flow (canonical example)

1. `task.sync` (cron) upserts GitHub issues into `tasks`; the board updates live (outbox → pub/sub → SSE).
2. User picks a task, chooses the "Implement → Review → PR" workflow, hits **Start** → `POST /api/v1/flow-runs` → one transaction: `flow_runs` row, first `flow_steps` row, outbox event.
3. Worker: `flow.advance` → `Scm` creates the flow's worktree (mirror clone → `git worktree add`, branch `agentforge/task-<key>`).
4. Engine starts the `implement` step → `Execution` context spawns a sandbox on the worktree, runs the *Implementer* agent through its adapter, streaming normalized events into `run_events`.
5. Run succeeds → `RunSucceeded` → outbox → `flow.advance`: engine resolves edges, starts the `triage` **decision step** — a real (auditable) run of the *Review Triage* agent whose output is coerced to `deep | light`; route + reasoning land on the step row.
6. Engine follows `route:deep` (say) → *Reviewer* agent runs **in the same worktree**, sees the implementer's actual changes, fixes or annotates.
7. Review step succeeds → `pr` step: `Scm` pushes the branch and opens the PR (worker-held credentials — agents never hold push rights).
8. Flow completes; task → `done`; optional `notify` + comment back on the source issue. The frontend timeline shows every step, every decision with reasoning, and the cumulative diff.

Single manual runs are the degenerate case: a one-node flow, same machinery.

---

## 3. Domain Model

- **User** — local account (email + password/passkey) or OIDC identity.
- **Project** — repository + configuration: default agent, env template, allowed commands; the unit of secrets scoping.
- **Task source** — per-project sync config (kind + credentials ref + cron) for GitHub Issues / Jira / tracked file.
- **Task** — unit of work on the board, synced or manual; what users pick to start a workflow.
- **Agent** — registered runtime configuration: adapter (`claude-code`, `codex-cli`, `openhands`, `aider`, `api-loop`), model, flags, image.
- **Workflow** — user-authored, versioned DAG of nodes (triggers, agent actions, decisions, gates) built on the canvas; stored as data, interpreted by the engine.
- **Flow run** — one execution of one workflow version for one task; owns the shared worktree and accumulated context.
- **Flow step** — one node execution; an `agent` step owns a Run; a `decision` step records route + reasoning.
- **Run** — one execution of one agent; owns the run state machine and the append-only event log.
- **Run event / Run input** — normalized protocol events out of the agent; steering/approvals/cancellation in.
- **Artifact** — durable output: diff, PR URL, files, log bundle.
- **Schedule** — cron template for auto-started flows (nightly upgrades etc.).
- **Secret** — encrypted key/value per project, decrypted only in the worker at provisioning time.

### 3.1 State machines

```
Run:      queued → provisioning → running ⇄ awaiting_input → finalizing → succeeded | failed | cancelled
FlowRun:  running ⇄ awaiting_input → succeeded | failed | cancelled
Task:     backlog → in_flow → done | failed → archived
```

Transitions are aggregate methods (domain errors on illegal moves) plus DB-level enum + trigger enforcement. `awaiting_input` (permission gates, agent questions, human gates) auto-fails after a configurable timeout so unattended flows never hang forever.

---

## 4. Data Model (PostgreSQL 18)

TypeORM persistence entities mirror this DDL; **migrations are TypeORM migration classes with hand-written SQL** (generated diffs are a starting point, never committed blind), so PG-18 features (`uuidv7()`, enums, partial indexes) stay first-class. Conventions: `uuidv7()` PKs (native in PG 18 — time-ordered, index-friendly), `timestamptz`, `jsonb` for protocol payloads.

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  email         citext UNIQUE NOT NULL,
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id       uuid NOT NULL REFERENCES users(id),
  name           text NOT NULL,
  repo_url       text NOT NULL,              -- https/ssh; local paths allowed in self-host mode
  default_branch text NOT NULL DEFAULT 'main',
  settings       jsonb NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE agents (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  owner_id   uuid NOT NULL REFERENCES users(id),
  name       text NOT NULL,                  -- "Implementer", "Review Triage", "Reviewer"
  adapter    text NOT NULL,                  -- 'claude-code'|'codex-cli'|'openhands'|'aider'|'api-loop'
  config     jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE TABLE task_sources (
  id             uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id     uuid NOT NULL REFERENCES projects(id),
  kind           text NOT NULL,              -- 'github_issues'|'jira'|'file'|'manual'
  config         jsonb NOT NULL DEFAULT '{}',
  sync_cron      text,
  last_synced_at timestamptz
);

CREATE TABLE tasks (
  id           uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id   uuid NOT NULL REFERENCES projects(id),
  source_id    uuid REFERENCES task_sources(id),
  external_key text,                          -- 'owner/repo#123', 'PROJ-45'
  title        text NOT NULL,
  body         text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'backlog',
  meta         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, external_key)
);

CREATE TABLE workflows (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES projects(id),
  name       text NOT NULL,
  version    int  NOT NULL DEFAULT 1,        -- editing a used workflow creates version n+1
  definition jsonb NOT NULL,                 -- nodes + edges DAG (§7), schema-validated on write
  enabled    boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, name, version)
);

CREATE TYPE flow_status AS ENUM ('running','awaiting_input','succeeded','failed','cancelled');

CREATE TABLE flow_runs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  workflow_id uuid NOT NULL REFERENCES workflows(id),  -- pins the exact version
  task_id     uuid NOT NULL REFERENCES tasks(id),
  status      flow_status NOT NULL DEFAULT 'running',
  context     jsonb NOT NULL DEFAULT '{}',   -- worktree ref, accumulated node outputs
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE TABLE flow_steps (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  flow_run_id uuid NOT NULL REFERENCES flow_runs(id),
  node_id     text NOT NULL,
  kind        text NOT NULL,                 -- 'trigger'|'action'|'agent'|'decision'|'gate'
  status      text NOT NULL DEFAULT 'running',
  run_id      uuid REFERENCES runs(id),      -- when kind = 'agent' or 'decision'
  decision    jsonb,                         -- {route, reasoning} when kind = 'decision'
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX flow_steps_by_flow ON flow_steps (flow_run_id, started_at);

CREATE TYPE run_status AS ENUM
  ('queued','provisioning','running','awaiting_input','finalizing','succeeded','failed','cancelled');

CREATE TABLE runs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id  uuid NOT NULL REFERENCES projects(id),
  agent_id    uuid NOT NULL REFERENCES agents(id),
  status      run_status NOT NULL DEFAULT 'queued',
  task_prompt text NOT NULL,
  base_ref    text NOT NULL,
  branch      text,
  usage       jsonb NOT NULL DEFAULT '{}',   -- tokens, cost, wall time
  error       text,
  lease_at    timestamptz,                   -- worker heartbeat for crash recovery
  created_at  timestamptz NOT NULL DEFAULT now(),
  started_at  timestamptz,
  finished_at timestamptz
);
CREATE INDEX runs_active ON runs (status)
  WHERE status IN ('queued','provisioning','running','awaiting_input','finalizing');

CREATE TABLE run_events (
  run_id  uuid NOT NULL REFERENCES runs(id),
  seq     bigint NOT NULL,                   -- per-run monotonic, assigned by orchestrator
  ts      timestamptz NOT NULL DEFAULT now(),
  type    text NOT NULL,                     -- normalized protocol event type (§6.2)
  payload jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);
-- Append-only: no UPDATE/DELETE grants for the app role; enforced by trigger too.

CREATE TABLE run_inputs (
  id          uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id      uuid NOT NULL REFERENCES runs(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL,                 -- 'message'|'approval'|'cancel'
  payload     jsonb NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE artifacts (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  run_id     uuid NOT NULL REFERENCES runs(id),
  kind       text NOT NULL,                  -- 'diff'|'pr'|'file'|'log-bundle'
  name       text NOT NULL,
  content    bytea,                          -- small inline; large on the artifacts volume
  path       text,
  meta       jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schedules (
  id            uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id    uuid NOT NULL REFERENCES projects(id),
  workflow_id   uuid NOT NULL REFERENCES workflows(id),
  name          text NOT NULL,
  cron          text NOT NULL,
  timezone      text NOT NULL DEFAULT 'UTC',
  enabled       boolean NOT NULL DEFAULT true,
  last_fired_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE secrets (
  id         uuid PRIMARY KEY DEFAULT uuidv7(),
  project_id uuid NOT NULL REFERENCES projects(id),
  key        text NOT NULL,
  ciphertext bytea NOT NULL,                 -- AES-256-GCM, key from AGENTFORGE_SECRET_KEY
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, key)
);

CREATE TABLE outbox_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  aggregate_type text NOT NULL,              -- 'run'|'flow_run'|'task'|…
  aggregate_id   uuid NOT NULL,
  event_type     text NOT NULL,              -- 'run.succeeded'|'decision.made'|'task.synced'|…
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz
);
CREATE INDEX outbox_pending ON outbox_events (id) WHERE dispatched_at IS NULL;
```

Design notes:

- **`run_events` is the spine.** Timeline rendering, lossless SSE resume, audit, and replay all read the same log; adapters attach runtime-native detail under `payload.raw` without schema churn.
- **`outbox_events` is the bridge** between Postgres truth and Redis delivery (§2.4); dispatched rows are pruned after 7 days by maintenance.
- **Partitioning deferred.** `run_events` grows fastest; past ~50M rows, declaratively partition by hash or month — documented so the decision isn't rediscovered.

---

## 5. Jobs, Queues, and Cron (BullMQ on Redis)

### 5.1 Role and boundaries

BullMQ (via `@nestjs/bullmq`) carries **work-in-motion**; Postgres carries **truth**. Nothing in Redis is authoritative: a job payload is only an ID + event descriptor, and every processor re-reads current state from Postgres before acting. This division is what keeps Redis disposable and the backup story Postgres-only.

Kafka and RabbitMQ were evaluated and rejected for v1: there is no high-throughput stream to partition (Kafka's case) and no complex inter-service routing topology (Rabbit's case) — this is a job queue workload, runs-per-minute scale, single host. BullMQ wins on Nest integration, delayed/repeatable jobs, per-queue concurrency, and operational familiarity (§13, ADR 1).

### 5.2 Queue topology

| Queue | Payload | Concurrency | Retry policy |
|---|---|---|---|
| `flow.advance` | `{ flowRunId, event }` | 5 | 3× backoff — engine ticks are idempotent (deterministic `jobId`) |
| `run.execute` | `{ runId }` | `AGENT_MAX_CONCURRENT_RUNS` (default 3) | none — crashed runs recover via reconciliation, not blind re-run |
| `run.finalize` | `{ runId }` | 2 | 3× backoff — commit, artifact capture, push/PR are retryable |
| `task.sync` | `{ taskSourceId }` | 2 | 3× backoff — pull GitHub Issues/Jira/file → upsert `tasks` |
| `repo.sync` | `{ projectId }` | 2 | 3× backoff — refresh mirrors |
| `maintenance.cleanup` | `{}` | 1 | — prune sandboxes/worktrees, expire stale `awaiting_input`, prune outbox |
| `notify.deliver` | `{ event, channel }` | 5 | 5× backoff — webhooks/email |

Long agent execution stays inside one `run.execute` processor (BullMQ lock extended via heartbeat). Progress checkpoints continuously to `runs`/`run_events`, so recovery is resume-shaped, not retry-shaped.

### 5.3 Cron

BullMQ **Job Schedulers** (repeatable jobs), all registered by the worker at boot:

1. **System cron** — `maintenance.cleanup` every 10 min; `task.sync`/`repo.sync` per source/project settings.
2. **User schedules** — rows in `schedules` (cron + IANA timezone) mapped to schedulers named `schedule:<id>`; CRUD in the UI re-syncs the scheduler; a reconciliation pass at boot repairs drift (**source of truth: the `schedules` table**, never Redis).

Missed ticks while the host was off are not replayed by default; a per-schedule `catch_up` flag opts into one catch-up fire.

### 5.4 Crash recovery & Redis-loss recovery

On worker boot (and every 60s), reconciliation runs **against Postgres**:

- Runs in active states with a stale `lease_at` → attempt resume (reattach to a surviving sandbox if the adapter supports it — `api-loop` does, Claude Code via `--resume`); otherwise mark failed with `orchestrator.crash_recovered`, preserving the worktree.
- Flow runs `running` with no active step and no pending `flow.advance` job → re-enqueue an advance tick.
- Undispatched `outbox_events` → dispatch (this alone rebuilds Redis from zero after a flush: schedulers re-register, pending work re-enqueues).
- Orphaned sandboxes/worktrees (label `agentforge.flow` with no active flow) → destroyed by cleanup.

**Losing Redis loses no work and no history — at worst, in-flight ticks repeat, and every processor is idempotent against Postgres state.**

---

## 6. Agent-Agnostic Adapter Layer

The heart of the "agent-agnostic" claim; shaped like LSP — **N agents × 1 protocol × 1 UI** — instead of N bespoke integrations. Adapters live in `packages/core/adapters/` (framework-free) and are registered with the `AgentRegistry` context.

### 6.1 Adapter interface

```ts
export interface AgentAdapter {
  readonly id: string;                     // 'claude-code' | 'codex-cli' | 'openhands' | 'aider' | 'api-loop'
  readonly capabilities: AdapterCapabilities;
  start(ctx: RunContext): Promise<AgentHandle>;
  resume?(ctx: RunContext, state: ResumeState): Promise<AgentHandle>;   // reattach after worker restart
}

export interface AgentHandle {
  events: AsyncIterable<AgentEvent>;       // normalized stream — the ONLY way agent activity reaches core
  send(input: UserMessage): Promise<void>;                        // mid-run steering
  respondToPermission(id: string, decision: 'allow' | 'deny', note?: string): Promise<void>;
  stop(reason: StopReason): Promise<void>; // graceful, then SIGKILL after grace period
}

export interface AdapterCapabilities {
  steering: boolean;
  permissionGates: boolean;
  resume: boolean;
  costReporting: boolean;
  structuredOutput: boolean;               // can be constrained to routes — required for decision.agent nodes
}
```

Capabilities are declared, not assumed: the canvas refuses to bind a `decision.agent` node to an agent whose adapter lacks `structuredOutput`; the UI disables the steering box when `steering: false`. `RunContext` exposes the sandbox handle, prompt, model config, and decrypted env — adapters get **no database access and no Docker socket**.

### 6.2 Normalized event protocol

```ts
type AgentEvent =
  | { type: 'agent.message';      text: string }
  | { type: 'agent.thinking';     text: string }
  | { type: 'tool.start';         tool: string; detail: Json }
  | { type: 'tool.end';           tool: string; ok: boolean; output: string }
  | { type: 'file.change';        path: string; diff: string }
  | { type: 'permission.request'; id: string; action: string; detail: Json }   // → awaiting_input
  | { type: 'usage';              tokensIn: number; tokensOut: number; costUsd?: number }
  | { type: 'result';             outcome: 'success' | 'failure'; summary: string; structured?: Json }
  | { type: 'fatal';              error: string };
```

Zod-validated at the adapter boundary; unmappable native events are preserved under `payload.raw`. The UI understands nine event types regardless of which agent ran.

### 6.3 CLI adapters

Spawned **inside the sandbox container** in their JSON/stream mode, driven over stdio:

| Adapter | Invocation shape | Notes |
|---|---|---|
| `claude-code` | headless/print mode, JSON stream output, permission hooks | richest mapping: tools, thinking, cost; supports resume |
| `codex-cli` | non-interactive exec mode, JSON output | exec events → `tool.*` |
| `openhands` | headless mode | event stream → protocol |
| `aider` | scripted mode; prompts → `permission.request` | diffs parsed from git, not stdout |

Each adapter is ~200–400 lines. CLI flags are pinned per adapter version and validated at boot (`--version` handshake) — incompatible versions fail loudly at registration, not mid-run.

### 6.4 The `api-loop` adapter

AgentForge's own loop against provider SDKs — Anthropic, OpenAI, or any OpenAI-compatible endpoint (Ollama/vLLM for the fully-offline path). Small auditable toolset via sandbox exec: `run_command`, `read_file`, `write_file`, `apply_patch`, `search`. It is the reference implementation: every event type emitted, `allowed_commands` policy enforced exactly, resume via transcript replay, and native structured output — which makes it the default engine for `decision.agent` nodes.

### 6.5 Adding a new agent

Adapter module + sandbox image layer + registry entry + passing the **conformance suite** (golden event sequence, permission-gate behavior, clean cancellation, structured-output contract if declared). No changes to schema, API, UI, or worker.

---

## 7. Workflow Engine

Users draw, on the canvas, how their registered agents cooperate — the worker executes that drawing. **Workflows are data**: a versioned JSON DAG in `workflows.definition`, interpreted by the `Orchestration` context's process manager. No embedded workflow platform, no DSL — what you see on the canvas is exactly what is stored and exactly what runs.

### 7.1 Node types

| Type | What it does | Produces |
|---|---|---|
| `trigger.task_selected` | flow starts when a user picks a task and hits "Start" | the task |
| `trigger.task_synced` | auto-start for tasks matching a filter (e.g. label `agentforge`) | the task |
| `trigger.schedule` | cron-started flow (§5.3) | tick |
| `action.create_worktree` | create the flow's shared git worktree from `base_ref` | `worktree` in context |
| `action.agent` | run a registered agent (full §6 run) in the flow's worktree | run result + diff |
| `decision.agent` | a registered agent chooses a route; output constrained to declared routes | `{route, reasoning}` |
| `decision.rule` | route on an expression over context (diff size, files touched, labels) | `{route}` |
| `gate.human` | pause for user approval on the frontend (flow → `awaiting_input`) | approval |
| `action.open_pr` | push branch, open PR (or emit patch artifact if no remote) | PR URL |
| `action.notify` | webhook/email via `notify.deliver` | — |

Edges connect an outcome to the next node: `on: succeeded | failed | route:<name> | approved | rejected`. Every node reads the **flow context** (accumulated jsonb: task, worktree, diffs, decisions); agent prompts are templates over it (`{{task.title}}`, `{{steps.implement.summary}}`).

### 7.2 The canonical example as a definition

```json
{
  "nodes": [
    { "id": "start",     "type": "trigger.task_selected" },
    { "id": "worktree",  "type": "action.create_worktree" },
    { "id": "implement", "type": "action.agent", "agent": "Implementer",
      "prompt": "Implement this task:\n{{task.title}}\n\n{{task.body}}" },
    { "id": "triage",    "type": "decision.agent", "agent": "Review Triage",
      "routes": ["deep", "light"],
      "prompt": "Deep review (security/arch impact, >300 lines, auth or migrations touched) or light?\n{{steps.implement.diff_summary}}" },
    { "id": "deep",      "type": "action.agent", "agent": "Reviewer",
      "prompt": "Thorough line-by-line review. Fix findings or report blockers.\n{{steps.implement.diff}}" },
    { "id": "light",     "type": "action.agent", "agent": "Reviewer",
      "prompt": "Quick sanity review: obvious bugs, missing tests.\n{{steps.implement.diff}}" },
    { "id": "pr",        "type": "action.open_pr", "title": "{{task.external_key}}: {{task.title}}" }
  ],
  "edges": [
    { "from": "start",     "to": "worktree",  "on": "succeeded" },
    { "from": "worktree",  "to": "implement", "on": "succeeded" },
    { "from": "implement", "to": "triage",    "on": "succeeded" },
    { "from": "triage",    "to": "deep",      "on": "route:deep" },
    { "from": "triage",    "to": "light",     "on": "route:light" },
    { "from": "deep",      "to": "pr",        "on": "succeeded" },
    { "from": "light",     "to": "pr",        "on": "succeeded" }
  ]
}
```

Validated on save (Zod schema in `packages/core`, shared with the canvas): referenced agents must exist, every declared route must have an edge, the graph must be acyclic and connected, exactly one trigger. Invalid graphs cannot be saved, so the engine never sees them.

### 7.3 Execution semantics

- **Event-driven, queue-ticked:** a step finishing produces an integration event → outbox → `flow.advance` job. One tick = load definition + `flow_runs.context`, resolve outgoing edges, insert next `flow_steps`, emit their outbox events — one transaction. The engine holds no in-memory state; crash-safety follows from §5.4.
- **Steps share the flow's worktree** (§8): the reviewer sees exactly the implementer's working tree. Each agent step still gets its own sandbox container; the worktree volume carries over.
- A `decision.agent` step is a real, visible run whose output is coerced to a declared route; `decision.reasoning` is stored on the step and rendered on the timeline — users see *why* the deep review was chosen.
- Failure routing: `on: failed` edges make failure a first-class path; a failed step with no failure edge fails the flow, preserving worktree + history for inspection.
- Task status follows the flow (`in_flow` → `done`/`failed`); an optional terminal action posts the outcome back to the task source.
- **Versioning:** a flow run pins its exact `workflow_id` version row; editing a used workflow creates version n+1; old timelines always render against the graph that actually executed.

---

## 8. Sandboxing & Worktrees

- **Per-project mirror** (`git clone --mirror`, refreshed by `repo.sync`) → **per-flow worktree** (`git worktree add`, branch `agentforge/task-<key>`): creation is near-instant and disk-cheap; all steps of a flow share it; standalone runs get a throwaway worktree of their own.
- **One sandbox container per agent step**, from the project's sandbox image (default `agentforge/sandbox-base`: Debian + git + Node + Python + build tools; projects can pin a custom image). The worktree is bind-mounted; the final diff is `git diff base_ref` — cheap, exact, reviewable.
- **Network policy** per project: `full` (default), `llm-only` (egress allow-list via proxy sidecar), or `none` (`api-loop` + local models — the agent literally cannot exfiltrate).
- **Resource limits:** CPU/memory/pids caps and per-run wall-clock timeout (default 2h) enforced by the orchestrator.
- Secrets are injected as env into the sandbox at start, decrypted only in worker memory; a redaction pass scrubs known secret values from event payloads before insert.
- Push/PR happens in `Scm` from the worker — **agents never hold push credentials**.

---

## 9. API Design

REST under `/api/v1` — NestJS controllers in each context's `interface/` layer. Zod validation pipes with schemas from `packages/core` (the React app imports the same types — no drift). Errors: RFC 9457 `application/problem+json` via a global exception filter. Auth: session cookie (guard) or Bearer PAT. OpenAPI generated from the Zod schemas at `/api/v1/openapi.json`.

| Method & path | Purpose |
|---|---|
| `POST /api/v1/auth/login` · `/logout` | session auth |
| `GET/POST /api/v1/projects` · `GET/PATCH/DELETE /api/v1/projects/:id` | project CRUD |
| `PUT/DELETE /api/v1/projects/:id/secrets/:key` | write-only secrets |
| `GET/POST /api/v1/agents` · `GET/PATCH/DELETE /api/v1/agents/:id` | registered agents |
| `GET /api/v1/adapters` | installed adapters + capabilities |
| `GET/POST /api/v1/task-sources` · `POST /api/v1/task-sources/:id/sync` | sources + manual sync |
| `GET /api/v1/tasks?status&cursor` · `POST /api/v1/tasks` · `PATCH /api/v1/tasks/:id` | task board |
| `GET/POST /api/v1/workflows` · `GET /api/v1/workflows/:id` · `POST /api/v1/workflows/:id/versions` | workflow definitions (edit = new version) |
| `POST /api/v1/flow-runs` | start a flow: `{workflow_id, task_id}` |
| `GET /api/v1/flow-runs?cursor` · `GET /api/v1/flow-runs/:id` | history; detail = steps + decisions + context |
| `GET /api/v1/flow-runs/:id/stream` | **SSE**: step transitions + nested run events |
| `POST /api/v1/flow-runs/:id/gate` | approve/reject a `gate.human` step |
| `GET /api/v1/flow-runs/:id/diff` | cumulative diff of the flow worktree |
| `GET /api/v1/runs/:id` · `GET /api/v1/runs/:id/events?after_seq=` | run detail + event history |
| `GET /api/v1/runs/:id/events/stream` | **SSE** live run stream (resumable via `Last-Event-ID`) |
| `POST /api/v1/runs/:id/inputs` | steer: `{kind: message|approval|cancel}` |
| `GET /api/v1/artifacts/:id/download` | outputs |
| `GET/POST /api/v1/schedules` · `PATCH/DELETE /api/v1/schedules/:id` · `POST /:id/fire` | cron schedules |
| `GET /api/v1/health` | DB + Redis reachable, worker heartbeat fresh, queue depth |

**SSE mechanics:** endpoints subscribe to Redis pub/sub as a wake-up signal, then read rows past the client's durable cursor (`run_events.seq` / step timestamps) from Postgres. `Last-Event-ID` = cursor, so reconnects are lossless even across Redis restarts; heartbeat every 25s; the nginx proxy passes streams through unbuffered.

---

## 10. Frontend (React 19 + Carbon Design System)

### 10.1 Principles

Carbon (`@carbon/react`) is used **as-is**: its components, grid, spacing scale, and type ramp — no Tailwind, no custom design system, custom CSS only for the two things Carbon doesn't provide (the canvas skin and the diff view). The result is IBM-grade information density and accessibility (WCAG-audited components) with near-zero design decisions to maintain. Theme: `g10` (light) default, `g100` (dark) via Carbon theme tokens; IBM Plex bundled locally — no CDN, per local-first.

Stack: React 19 + Vite SPA; **TanStack Query** for all server state (SSE messages invalidate/patch query caches — no bespoke store); **React Router**; **`@xyflow/react`** for the workflow canvas; Carbon icons throughout. `packages/core` supplies API DTO types and the workflow-definition schema, so the canvas validates graphs client-side with the exact schema the server enforces.

### 10.2 Screens

| Screen | Built from | What the user sees |
|---|---|---|
| **Task Board** | Carbon `DataTable` (+ toolbar, filters), `Tag` for status/labels | synced GitHub/Jira/file tasks; pick a task → "Start workflow" (`Dropdown` of workflows + `Button`) |
| **Workflow Canvas** | `@xyflow/react` canvas; Carbon `Tile`-styled nodes; side panel (`Form`, `Select`, `TextArea`) as node inspector; palette of node types | drag agents/decisions/gates, connect outcomes; live schema validation (`InlineNotification` for graph errors); Save = new version |
| **Flow Run Timeline** | Carbon `ProgressIndicator` (vertical) for steps; `Accordion` per step; `Tag type="purple"` decision badges with reasoning popover (`Toggletip`); `CodeSnippet` for commands | the story of the flow: each hand-off, each decision + *why*, gates awaiting approval (`Modal`), links into each run |
| **Run Detail** | virtualized event feed (`StructuredList` rows per §6.2 event type), `InlineLoading` while running; steering `TextInput` + send | the agent's live narration, tool calls, permission requests (`ActionableNotification` approve/deny) |
| **Diff View** | custom diff component (Carbon-tokened colors), file tree via `TreeView` | cumulative flow diff / per-run diff, side-by-side or unified |
| **Settings** | Carbon `Form`s: projects, agents, task sources, schedules, PATs | all registry CRUD |

### 10.3 UI ↔ realtime contract

One SSE subscription per open flow/run; messages carry `(cursor, type, payload)`. The client applies them optimistically to the TanStack Query cache keyed by `['flow', id]` / `['run', id, 'events']`, and on reconnect refetches from its last cursor — the same lossless-resume semantics the API guarantees (§9). Nothing on the frontend ever assumes a message was not missed.

### 10.4 Component conventions

- Feature-folder structure mirroring bounded contexts (`features/tasks`, `features/workflows`, `features/runs`) — screens compose feature components; feature components compose Carbon primitives. No cross-feature imports except through shared hooks.
- All status rendering flows from the two enums (`run_status`, `flow_status`) through one `<StatusTag>` mapping to Carbon `Tag` colors — a status is rendered identically everywhere.
- Forms validate with the shared Zod schemas before submit; server errors (RFC 9457) map onto Carbon `Form` field invalidity.

---

## 11. Local-First Deployment

### 11.1 Docker Compose

```yaml
services:
  postgres:
    image: postgres:18
    volumes: [pgdata:/var/lib/postgresql/data]
    environment:
      POSTGRES_DB: agentforge
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 5s }

  redis:
    image: redis:7-alpine
    command: ["redis-server", "--appendonly", "yes"]   # nice-to-have; system survives total Redis loss (§5.4)
    volumes: [redisdata:/data]

  api:
    image: agentforge/server:latest        # NestJS 11; CMD node dist/main.api.js
    environment: &appenv
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@postgres:5432/agentforge
      REDIS_URL: redis://redis:6379
      AGENTFORGE_SECRET_KEY: ${AGENTFORGE_SECRET_KEY}   # 32-byte base64; encrypts secrets at rest
      AGENTFORGE_BASE_URL: http://localhost:3000
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_started }
    # no published ports — reachable only via the frontend proxy

  frontend:
    image: agentforge/frontend:latest      # nginx: React SPA + /api/v1 proxy (SSE unbuffered)
    ports: ["3000:3000"]                   # the single public origin
    environment:
      API_ORIGIN: http://api:3001
    depends_on: [api]

  worker:
    image: agentforge/server:latest        # same image as api
    command: ["node", "dist/main.worker.js"]
    environment:
      <<: *appenv
      AGENT_MAX_CONCURRENT_RUNS: "3"
      SANDBOX_NETWORK_DEFAULT: full
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - workspaces:/data/workspaces        # mirrors + worktrees
      - artifacts:/data/artifacts
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_started }

volumes: { pgdata: {}, redisdata: {}, workspaces: {}, artifacts: {} }
```

`api` and `worker` are **one image with two entrypoints** — a Nest module boundary, not a build boundary. First boot: api runs TypeORM migrations (advisory-lock-guarded), then a setup wizard at `/setup` creates the first user, project, agents, and offers workflow templates (including the canonical Implement → Triage → Review → PR). Automation clients use the same `:3000` origin with a Bearer PAT.

### 11.2 What "local-first" means operationally

- **Data residency:** repos, worktrees, event logs, prompts, decisions, and keys live only on the host. Only outbound traffic is the agents' LLM calls — and `api-loop` + local model + `SANDBOX_NETWORK=none` eliminates even that.
- **Backup = `pg_dump` + volumes.** Redis is excluded on purpose: §5.4 reconstructs queue state from Postgres on restore.
- **No phone-home.** No telemetry; update check is manual.
- **Hosted mode is config, not code:** TLS in front of frontend, OIDC env, managed Postgres/Redis, scale `api`/`worker` replicas (stateless api; `SKIP LOCKED` outbox + BullMQ + run leases already assume competing consumers).

### 11.3 Dev mode

`pnpm dev` runs frontend (Vite dev server, proxy to api), api (`nest start --watch`), worker (second watch), dockerized Postgres 18 + Redis 7. `SANDBOX_DRIVER=process` downgrades sandboxes to child processes in temp dirs for fast adapter work — same adapter code, different driver.

---

## 12. Security

- **Threat model headline: the agent is untrusted.** It executes model-chosen commands on model-chosen inputs. Sandboxing, permission gates, network policy, and worker-only credentials all follow from this.
- Frontend and api have no Docker socket; api, worker, redis, postgres publish no host ports. Compromise of the public frontend ≠ database access; compromise of api ≠ host code execution.
- Secrets: AES-256-GCM at rest, write-only API, decrypted only in worker memory, redacted from event payloads.
- PATs hashed (SHA-256), scoped per user, revocable. Sessions: SameSite=Lax + origin checks; the single-origin proxy leaves no CORS surface.
- `run_events` + `outbox_events` append-only for the app DB role — app-level SQL compromise cannot rewrite audit history.
- Prompt-injection stance: repo and task content are untrusted input to the agent; protection is **capability limitation** (network policy, allowed_commands, push-from-worker-only, human gates) rather than trusting the model to resist. A `gate.human` before `action.open_pr` is the recommended default for flows triggered by external task sources.

---

## 13. Key Decisions (ADR summary)

| # | Decision | Alternatives | Why |
|---|---|---|---|
| 1 | **BullMQ on Redis** for jobs/cron | pg-boss / Graphile Worker (v0.1–0.3 choice), Kafka, RabbitMQ | Team-standard Nest integration (`@nestjs/bullmq`), mature delayed/repeatable jobs, per-queue concurrency. Kafka rejected: no partitioned-stream workload, heavy ops for a self-hosted single box. RabbitMQ rejected: no routing topology need; another broker to operate with fewer batteries for job semantics. Cost vs pg-boss — lost transactional enqueue and a second stateful service — paid down by ADR 2. |
| 2 | **Transactional outbox** bridging Postgres → Redis | dual-write, listen-to-WAL (CDC) | State change + event commit atomically; dispatcher gives at-least-once with idempotent consumers; doubles as full Redis-loss recovery. CDC (Debezium) is drastically more ops than one polled table. |
| 3 | **Redis is disposable; Postgres is truth** | queue state as co-source-of-truth | Keeps the local-first backup story `pg_dump`-only; reconciliation rebuilds Redis from scratch (§5.4). |
| 4 | SSE + Redis pub/sub wake-up + durable PG cursor | WebSockets, polling | One-directional stream fits (inputs are plain POSTs); `Last-Event-ID` ↔ `seq` gives lossless resume across client *and* Redis restarts; no ws-gateway infra. |
| 5 | Event-sourced `run_events` as UI source of truth | mutable run document | Lossless reconnect, audit, replay, agent-agnostic rendering; partitioning path documented. |
| 6 | Adapters normalize to a 9-type protocol | per-agent UI plugins | N×1 instead of N×M; conformance suite keeps adapters honest; `payload.raw` preserves fidelity. |
| 7 | **NestJS DDD modular monolith**, api + worker as two entrypoints of one codebase | microservices, framework-less worker | Bounded contexts give team-scale structure without network boundaries; worker reuses providers via DI; contexts communicate only via events → extraction to services later is mechanical if ever needed. |
| 8 | **TypeORM with domain/persistence separation** | Prisma, Drizzle (v0.1–0.3 choice), MikroORM | Team choice; first-class Nest integration. DDD risk (ORM leaking into domain) contained by keeping TypeORM entities in `infrastructure/` with repository mappers; migrations are hand-reviewed SQL so PG-18 features stay usable. |
| 9 | **Workflows as data** (versioned JSON DAG) interpreted by a process manager | code-defined pipelines, Temporal/n8n embedding | Editable from the canvas, versioned, auditable, replayable; validation shared client/server. Temporal contradicts self-host-light; embedding n8n imports a platform for what is ~1k lines of engine. |
| 10 | **React 19 + Carbon Design System**, Carbon used as-is | Svelte + pure-CSS BEM (v0.3 choice), Tailwind + headless kit | Complete accessible enterprise component set (tables, forms, notifications, shell) eliminates design-system build-out; dense data UIs are Carbon's home turf; React ecosystem needed for `@xyflow/react` canvas. Custom CSS confined to canvas skin + diff view. |
| 11 | Docker-per-step sandboxes + per-flow shared worktrees | fresh clone per run (v0.1), Firecracker/gVisor | Worktrees make multi-agent hand-off natural (reviewer sees implementer's tree) and cheap; isolation/effort trade-off right for self-host; `SANDBOX_DRIVER` leaves a microVM door open. |
| 12 | Long-running run = one BullMQ processor with lease heartbeat + resume-based recovery | step-function-style decomposition | Agent runs aren't idempotent steps; checkpoint-to-Postgres + reattach beats replaying side-effectful work. |

---

## 14. Observability

- **Structured logs** (pino via `nestjs-pino`) from api and worker, correlated by `flow_run_id`/`run_id`; sandbox stdout/stderr captured into run events and the log-bundle artifact.
- **Metrics** at `/api/v1/metrics` (Prometheus, token-gated): BullMQ queue depths, outbox lag, active runs/flows, run duration histograms, token/cost counters, worker heartbeat age, Redis/PG health.
- **The flow timeline is the trace viewer:** steps + decisions + nested run events render the whole execution; debugging rarely needs external tooling.
- Nightly digest (flows succeeded/failed, cost totals) via `notify.deliver`.

## 15. Open Questions / v2 Candidates

- **Remote/hosted agents** (Devin-style external services, ACP/MCP-speaking) as a third adapter family — protocol was shaped for it; credential and latency semantics need design.
- Parallel fan-out/fan-in nodes in workflows (run reviewer lenses concurrently, join on all-succeeded).
- Multi-user review workflows (second-human approval policies per project).
- Worktree snapshotting for time-travel debugging.
- Postgres logical replication as an optional sync channel between two self-hosted instances (multi-device local-first).

---

*Stack versions verified 2026-08-04: PostgreSQL 18.x (18.4 latest minor) · NestJS 11.x (v12 announced) · TypeORM 0.3.x · BullMQ 5.x · Redis 7.x · React 19.x · `@carbon/react` v1.9x.*