import { createAdminDataSource } from './data-source';

/** Arbitrary constant; identical across api replicas so only one migrates. */
const MIGRATION_ADVISORY_LOCK_KEY = 0x41474637; // 'AGF7'

/**
 * Runs pending migrations under a Postgres advisory lock so concurrent api
 * boots (replicas, restarts) serialize instead of racing DDL.
 */
export async function runMigrations(adminUrl: string): Promise<void> {
  const dataSource = createAdminDataSource(adminUrl);
  await dataSource.initialize();
  try {
    const lockRunner = dataSource.createQueryRunner();
    await lockRunner.connect();
    await lockRunner.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_ADVISORY_LOCK_KEY]);
    try {
      await dataSource.runMigrations({ transaction: 'each' });
    } finally {
      await lockRunner.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_ADVISORY_LOCK_KEY]);
      await lockRunner.release();
    }
  } finally {
    await dataSource.destroy();
  }
}
