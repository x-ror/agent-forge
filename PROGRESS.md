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
