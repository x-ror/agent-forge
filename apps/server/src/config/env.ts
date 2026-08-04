import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  /** App-role connection (restricted grants — append-only audit tables). */
  DATABASE_URL: z.string().default('postgres://agentforge_app:agentforge_app@localhost:5432/agentforge'),
  /** Owner/admin connection used only by the migration runner. */
  DATABASE_ADMIN_URL: z.string().default('postgres://postgres:agentforge@localhost:5432/agentforge'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  /** 32-byte base64; encrypts project secrets at rest. Dev fallback only. */
  AGENTFORGE_SECRET_KEY: z.string().default(Buffer.from('dev-dev-dev-dev-dev-dev-dev-dev!').toString('base64')),
  AGENTFORGE_BASE_URL: z.string().default('http://localhost:3000'),
  AGENT_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(3),
  SANDBOX_DRIVER: z.enum(['process', 'docker']).default('process'),
  SANDBOX_NETWORK_DEFAULT: z.enum(['full', 'llm-only', 'none']).default('full'),
  WORKSPACES_DIR: z.string().default('/tmp/agentforge/workspaces'),
  ARTIFACTS_DIR: z.string().default('/tmp/agentforge/artifacts'),
});

export type AppEnv = z.infer<typeof envSchema>;

/**
 * Merges a dotenv file into `target` WITHOUT overriding variables that are
 * already set — real environment always wins (the same precedence Node's
 * `--env-file` flag uses). Node-native parsing; no dotenv dependency.
 */
export function applyEnvFile(file: string, target: NodeJS.ProcessEnv = process.env): boolean {
  if (!existsSync(file)) return false;
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
  } catch {
    return false; // unreadable/binary file: ignore, real env still applies
  }
  for (const [key, value] of Object.entries(parsed)) {
    target[key] ??= value;
  }
  return true;
}

/**
 * .env discovery for the two entrypoints: an explicit AGENTFORGE_ENV_FILE
 * beats a `.env` in the working directory, which beats the repo-root `.env`
 * (the one docker compose also reads) when running from apps/server.
 */
export function loadEnvFiles(target: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = [target.AGENTFORGE_ENV_FILE, path.resolve(process.cwd(), '.env'), path.resolve(process.cwd(), '../../.env')].filter((file): file is string => !!file);
  const loaded: string[] = [];
  for (const file of candidates) {
    if (applyEnvFile(file, target)) loaded.push(file);
  }
  return loaded;
}

let envFilesLoaded = false;

export function loadEnv(source?: NodeJS.ProcessEnv): AppEnv {
  // Only implicit process.env loads pull in .env files; explicit sources
  // (tests) parse exactly what they were given.
  if (!source && !envFilesLoaded) {
    envFilesLoaded = true;
    loadEnvFiles();
  }
  return envSchema.parse(source ?? process.env);
}

/** DI token for the parsed environment. */
export const APP_ENV = Symbol('APP_ENV');
