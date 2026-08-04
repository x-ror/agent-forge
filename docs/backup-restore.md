# Backup & restore

**The backup story is Postgres-only** (design §11.2, ADR 3). Redis carries only work-in-motion — BullMQ jobs and pub/sub wake-ups — and every payload is just an ID; reconciliation (§5.4) rebuilds all of it from Postgres. Losing Redis loses no work and no history.

## What to back up

| Data | Where | Needed? |
|---|---|---|
| All domain state, event logs, workflows, tasks, secrets (encrypted) | Postgres (`pgdata` volume) | **yes — `pg_dump`** |
| Git mirrors + worktrees | `workspaces` volume | optional — mirrors re-clone from the remote; worktrees of *in-flight* flows are preserved work |
| Large artifacts | `artifacts` volume | optional (small artifacts live in Postgres) |
| Redis | `redisdata` volume | **no — disposable by design** |
| `.env` (`AGENTFORGE_SECRET_KEY`!) | host | **yes** — without the key, stored secrets are unrecoverable |

## Backup

```bash
docker compose exec postgres pg_dump -U postgres -Fc agentforge > agentforge-$(date +%F).dump
cp .env agentforge-env-backup   # contains the secret encryption key
```

## Restore (fresh machine)

```bash
# 1. bring up only postgres with the restored env
cp agentforge-env-backup .env
docker compose up -d postgres
docker compose exec -T postgres pg_restore -U postgres --clean --if-exists --create -d postgres < agentforge-2026-08-04.dump

# 2. start everything else — the api runs pending migrations, the worker's
#    reconciliation pass rebuilds Redis state from Postgres:
docker compose up -d
```

After restore:

- History, workflows (all versions), tasks, schedules and secrets are intact.
- Boot-time reconciliation re-enqueues execute jobs for queued runs and ticks every active flow; runs that were mid-execution during the backup are resumed where the adapter supports it, otherwise marked failed with an honest `orchestrator.crash_recovered` timeline entry — exactly the §5.4 semantics, which the integration suite exercises with a Redis `FLUSHALL` plus worker-kill tests.
- If the `workspaces` volume was not restored, mirrors re-clone on demand; a flow whose worktree vanished will fail its next step honestly and can be restarted from the task board.

## Verifying a backup

Restore into a scratch compose project and check:

```bash
curl -s localhost:3000/api/v1/health          # postgres: true, redis: true
# log in, open Flow Runs — timelines and decisions must render fully
```
