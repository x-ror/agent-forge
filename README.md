# AgentForge

An **agent-agnostic, local-first** web service for orchestrating autonomous coding agents — in the spirit of Devin, but self-hostable and open to any agent runtime.

- **Agent-agnostic**: a normalized run protocol (start / events / steer / stop) with adapters — `api-loop` (built-in loop against Anthropic or any OpenAI-compatible endpoint, including local models) and `claude-code` (headless CLI) ship today; adding a runtime is one adapter module (§6.5 of the design doc).
- **Local-first**: everything — UI, API, workers, Postgres, Redis, sandboxes, git worktrees — runs on one machine with Docker Compose. Code, credentials and history never leave the host. Backup is `pg_dump` only; Redis is disposable by design.
- **Workflows are data**: draw how your agents cooperate on a canvas (implement → triage decision → review → PR); the worker executes exactly that drawing, recording every hand-off, every decision *with its reasoning*, and every diff.

## Quickstart (5 minutes)

Prereqs: Docker with Compose.

```bash
git clone <this-repo> agentforge && cd agentforge
cp .env.example .env
# edit .env: set POSTGRES_PASSWORD, AGENTFORGE_APP_DB_PASSWORD and
#           AGENTFORGE_SECRET_KEY  (generate: openssl rand -base64 32)
docker compose up -d --build
```

Open **http://localhost:4400** — the first-boot wizard walks you through:

1. **Account** — the first local user.
2. **Project** — point at a repository (`https://github.com/you/repo.git`, ssh, or a local `file:///path/repo.git`).
3. **Agents** — registers *Implementer*, *Review Triage* and *Reviewer* on the built-in `api-loop` adapter; paste your Anthropic API key (stored encrypted, write-only).
4. **Workflows** — seeds the canonical *Implement → Review → PR* template (plus a gated variant with a human approval before the PR).

Then: add a task source (Settings → Task sources — GitHub Issues or a `TASKS.md` checklist in the repo), **Sync**, pick a task on the board, **Start workflow**, and watch the timeline: live agent events, the triage decision with visible reasoning, the review running in the same worktree, and the PR.

For GitHub push/PR and issue sync, store a `GITHUB_TOKEN` secret on the project (Settings → Secrets). Agents never see it — pushes happen worker-side (§12).

## Development

Prereqs: Node ≥ 22, pnpm 10 (via corepack), Docker.

```bash
pnpm install
pnpm dev:infra      # Postgres 18 + Redis 7 via docker-compose.dev.yml
pnpm -r build       # core → server → frontend
pnpm verify         # build + lint + format check + typecheck + tests
pnpm --filter @agentforge/frontend test:e2e   # Playwright: full-stack canonical flow
```

Dev servers: `pnpm --filter @agentforge/server dev` (api, tsc watch + node --watch), `dev:worker`, and `pnpm --filter @agentforge/frontend dev` (Vite on :3000, proxying `/api/v1` to :3001).

The api and worker read `.env` files natively (no dotenv dependency): an explicit `AGENTFORGE_ENV_FILE`, then `./.env`, then the repo-root `.env` — and real environment variables always take precedence over file values. The dev defaults already match `docker-compose.dev.yml`, so a `.env` is only needed to override them (see the commented dev section in `.env.example`).

Integration tests use testcontainers — they start their own Postgres/Redis and need nothing pre-running except Docker.

## Architecture in one paragraph

Postgres is the single source of truth; Redis carries only BullMQ jobs and pub/sub wake-ups and can be flushed at any time — reconciliation rebuilds it from Postgres (§5.4). All cross-process effects go through a transactional outbox. The api process is stateless (REST + SSE with durable cursors); the worker owns the outbox dispatcher, the flow engine (a stateless process manager over `flow_runs`/`flow_steps`), the run orchestrator (sandboxes, adapter lifecycles, lease heartbeats) and all credentials. `run_events` and `outbox_events` are append-only at the grant *and* trigger level. See `AgentForge — Technical Design Document.md` for the full design and `PROGRESS.md` for the build log.

## Local LLMs (no API key required)

The `api-loop` adapter speaks to any OpenAI-compatible server, which includes Ollama and LM Studio — so triage/review/decision agents can run entirely on your machine:

1. Run a local server, e.g. `ollama serve` (default `http://localhost:11434`) and pull a model: `ollama pull qwen3`.
2. In **Settings → Agents**, register (or edit) an agent with adapter `api-loop`, model set to your local model id (type a custom value, e.g. `qwen3`), and options:

   ```json
   { "provider": "openai", "baseUrl": "http://host.docker.internal:11434" }
   ```

3. Store any non-empty `OPENAI_API_KEY` project secret (local servers ignore it, the adapter requires one to be present).
4. Compose runs the worker in a container, so `localhost` is the container — use `host.docker.internal` and add to the worker service in `docker-compose.yml` if it can't resolve:

   ```yaml
   extra_hosts:
     - 'host.docker.internal:host-gateway'
   ```

The `claude-code` adapter keeps working with your Claude subscription (`CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`) — mix both in one workflow: local models for decisions, Claude for implementation.

## Operations

- **Backup / restore**: [docs/backup-restore.md](docs/backup-restore.md) — `pg_dump` + volumes; Redis is intentionally excluded.
- **Security model**: [SECURITY.md](SECURITY.md).
- **Metrics**: `GET /api/v1/metrics` (Prometheus format; authenticate with a PAT).
- **Health**: `GET /api/v1/health` — PG, Redis, worker heartbeat, queue depths.
