import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 8 engine needs: decision runs carry their structured-output spec;
 * artifacts can belong to flow-level steps (open_pr) that have no run.
 */
export class FlowEngine1754300000002 implements MigrationInterface {
  name = 'FlowEngine1754300000002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE runs ADD COLUMN structured jsonb`);
    await queryRunner.query(`ALTER TABLE artifacts ALTER COLUMN run_id DROP NOT NULL`);
    await queryRunner.query(`ALTER TABLE artifacts ADD COLUMN flow_run_id uuid REFERENCES flow_runs(id)`);
    await queryRunner.query(`CREATE INDEX artifacts_by_flow ON artifacts (flow_run_id)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS artifacts_by_flow`);
    await queryRunner.query(`ALTER TABLE artifacts DROP COLUMN IF EXISTS flow_run_id`);
    await queryRunner.query(`ALTER TABLE runs DROP COLUMN IF EXISTS structured`);
  }
}
