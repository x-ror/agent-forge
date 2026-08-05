import { Inject, Injectable } from '@nestjs/common';
import { In, type DataSource } from 'typeorm';
import type { Json } from '@agentforge/core';
import { DATA_SOURCE } from '../../../database/database.module';
import { toRow, toRows } from '../../../database/row';
import { Run, type RunStatus } from '../domain/run';
import type { Artifact, RunEvent, RunInput } from '../domain/run-event';
import type { ArtifactRepository, RunEventRepository, RunInputRepository, RunRepository, UsageDay } from '../domain/repositories';
import { ArtifactEntity, RunEntity, RunEventEntity, RunInputEntity } from './entities';

const RECOVERABLE_STATUSES: RunStatus[] = ['provisioning', 'running', 'awaiting_input', 'finalizing'];

function toDomain(entity: RunEntity): Run {
  return Run.restore({
    ...entity,
    usage: entity.usage as Run['usage'],
    resumeState: (entity.resumeState ?? null) as Json | null,
    structured: (entity.structured ?? null) as Json | null,
  });
}

@Injectable()
export class TypeormRunRepository implements RunRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async usageSummary(projectId: string, days: number): Promise<UsageDay[]> {
    const rows: Array<{ day: string; runs: string; tokens_in: string; tokens_out: string; cost_usd: string }> = await this.ds.query(
      `SELECT date_trunc('day', created_at)::date::text AS day,
              count(*)::text AS runs,
              COALESCE(SUM((usage->>'tokensIn')::bigint), 0)::text AS tokens_in,
              COALESCE(SUM((usage->>'tokensOut')::bigint), 0)::text AS tokens_out,
              COALESCE(SUM((usage->>'costUsd')::numeric), 0)::text AS cost_usd
       FROM runs
       WHERE project_id = $1 AND created_at > now() - make_interval(days => $2)
       GROUP BY 1
       ORDER BY 1 DESC`,
      [projectId, days],
    );
    return rows.map((r) => ({
      day: r.day,
      runs: Number(r.runs),
      tokensIn: Number(r.tokens_in),
      tokensOut: Number(r.tokens_out),
      costUsd: Number(r.cost_usd),
    }));
  }

  async insert(run: Run): Promise<void> {
    await this.ds.getRepository(RunEntity).insert(toRow<RunEntity>(run.snapshot()));
  }

  async save(run: Run): Promise<void> {
    await this.ds.getRepository(RunEntity).update({ id: run.id }, toRow<RunEntity>(run.snapshot()));
  }

  async findById(id: string): Promise<Run | null> {
    const entity = await this.ds.getRepository(RunEntity).findOneBy({ id });
    return entity ? toDomain(entity) : null;
  }

  async findStaleActive(cutoff: Date): Promise<Run[]> {
    const rows = await this.ds
      .getRepository(RunEntity)
      .createQueryBuilder('r')
      .where('r.status IN (:...statuses)', { statuses: RECOVERABLE_STATUSES })
      .andWhere('(r.lease_at IS NULL OR r.lease_at < :cutoff)', { cutoff })
      .getMany();
    return rows.map(toDomain);
  }
}

@Injectable()
export class TypeormRunEventRepository implements RunEventRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  /**
   * Per-run monotonic seq. The orchestrator is the single writer for a run's
   * events; the (run_id, seq) PK turns any violated assumption into a loud
   * conflict instead of silent interleaving.
   */
  async append(runId: string, events: Array<{ type: string; payload: Json }>): Promise<RunEvent[]> {
    if (events.length === 0) return [];
    return this.ds.transaction(async (em) => {
      const [row]: Array<{ last: string }> = await em.query(`SELECT COALESCE(MAX(seq), 0) AS last FROM run_events WHERE run_id = $1`, [runId]);
      let seq = Number(row!.last);
      const ts = new Date();
      const rows: RunEvent[] = events.map((e) => ({ runId, seq: ++seq, ts, ...e }));
      await em.getRepository(RunEventEntity).insert(toRows<RunEventEntity>(rows.map((r) => ({ ...r }))));
      return rows;
    });
  }

  async listAfter(runId: string, afterSeq: number, limit = 500): Promise<RunEvent[]> {
    const rows = await this.ds
      .getRepository(RunEventEntity)
      .createQueryBuilder('e')
      .where('e.run_id = :runId AND e.seq > :afterSeq', { runId, afterSeq })
      .orderBy('e.seq', 'ASC')
      .limit(limit)
      .getMany();
    return rows.map((r) => ({ ...r, payload: r.payload as Json }));
  }

  async lastSeq(runId: string): Promise<number> {
    const [row]: Array<{ last: string }> = await this.ds.query(`SELECT COALESCE(MAX(seq), 0) AS last FROM run_events WHERE run_id = $1`, [runId]);
    return Number(row!.last);
  }
}

@Injectable()
export class TypeormRunInputRepository implements RunInputRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(input: RunInput): Promise<void> {
    await this.ds.getRepository(RunInputEntity).insert(toRow<RunInputEntity>(input));
  }

  async pending(runId: string): Promise<RunInput[]> {
    const rows = await this.ds
      .getRepository(RunInputEntity)
      .createQueryBuilder('i')
      .where('i.run_id = :runId AND i.consumed_at IS NULL', { runId })
      .orderBy('i.created_at', 'ASC')
      .getMany();
    return rows.map((r) => ({ ...r, kind: r.kind as RunInput['kind'], payload: r.payload as Json }));
  }

  async markConsumed(id: string, at = new Date()): Promise<void> {
    await this.ds.getRepository(RunInputEntity).update({ id }, { consumedAt: at });
  }
}

@Injectable()
export class TypeormArtifactRepository implements ArtifactRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(artifact: Artifact): Promise<void> {
    await this.ds.getRepository(ArtifactEntity).insert(toRow<ArtifactEntity>(artifact));
  }

  async findById(id: string): Promise<Artifact | null> {
    const entity = await this.ds.getRepository(ArtifactEntity).findOneBy({ id });
    return entity ? { ...entity, kind: entity.kind as Artifact['kind'], meta: entity.meta as Artifact['meta'] } : null;
  }

  async listByRun(runId: string): Promise<Artifact[]> {
    const rows = await this.ds.getRepository(ArtifactEntity).find({ where: { runId: In([runId]) }, order: { createdAt: 'ASC' } });
    return rows.map((r) => ({ ...r, kind: r.kind as Artifact['kind'], meta: r.meta as Artifact['meta'] }));
  }
}
