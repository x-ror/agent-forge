import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { DataSource } from 'typeorm';
import { createAppDataSource } from '../../src/database/data-source';
import { runMigrations } from '../../src/database/migration-runner';

export interface PgTestContext {
  container: StartedPostgreSqlContainer;
  adminUrl: string;
  appUrl: string;
  stop(): Promise<void>;
}

/** Starts a PG 18 container and applies all migrations (admin), returning both URLs. */
export async function startMigratedPg(): Promise<PgTestContext> {
  const container = await new PostgreSqlContainer('postgres:18')
    .withDatabase('agentforge')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();
  const adminUrl = container.getConnectionUri();
  await runMigrations(adminUrl);
  const appUrl = `postgres://agentforge_app:agentforge_app@${container.getHost()}:${container.getMappedPort(5432)}/agentforge`;
  return {
    container,
    adminUrl,
    appUrl,
    stop: async () => {
      await container.stop();
    },
  };
}

export async function connectApp(appUrl: string): Promise<DataSource> {
  const ds = createAppDataSource(appUrl);
  await ds.initialize();
  return ds;
}
