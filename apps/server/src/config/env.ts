import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),
  /** App-role connection (restricted grants — append-only audit tables). */
  DATABASE_URL: z
    .string()
    .default('postgres://agentforge_app:agentforge_app@localhost:5432/agentforge'),
  /** Owner/admin connection used only by the migration runner. */
  DATABASE_ADMIN_URL: z.string().default('postgres://postgres:agentforge@localhost:5432/agentforge'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  AGENTFORGE_SECRET_KEY: z.string().optional(),
  AGENTFORGE_BASE_URL: z.string().default('http://localhost:3000'),
  AGENT_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(3),
  SANDBOX_DRIVER: z.enum(['process', 'docker']).default('process'),
  SANDBOX_NETWORK_DEFAULT: z.enum(['full', 'llm-only', 'none']).default('full'),
  WORKSPACES_DIR: z.string().default('/tmp/agentforge/workspaces'),
  ARTIFACTS_DIR: z.string().default('/tmp/agentforge/artifacts'),
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(source);
}

/** DI token for the parsed environment. */
export const APP_ENV = Symbol('APP_ENV');
