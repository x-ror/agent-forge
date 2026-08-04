import { Injectable } from '@nestjs/common';
import type { Json } from '@agentforge/core';
import { UnitOfWork } from '../../../database/unit-of-work';
import { toRow, toRows } from '../../../database/row';
import { OutboxWriter } from '../../../shared/outbox/outbox.writer';
import { EventTypes, type IntegrationEvent } from '../../../shared/outbox/integration-event';
import { RunEntity, RunEventEntity, RunInputEntity } from './entities';
import type { Run } from '../domain/run';
import type { RunEvent, RunInput } from '../domain/run-event';
import type { RunTxPort } from '../domain/ports';

@Injectable()
export class RunTxOps implements RunTxPort {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxWriter,
  ) {}

  async insertRun(run: Run, integrationEvents: IntegrationEvent[]): Promise<void> {
    await this.uow.withTx(async (em) => {
      await em.getRepository(RunEntity).insert(toRow<RunEntity>(run.snapshot()));
      await this.outbox.append(em, integrationEvents);
    });
  }

  async insertInput(input: RunInput, integrationEvents: IntegrationEvent[]): Promise<void> {
    await this.uow.withTx(async (em) => {
      await em.getRepository(RunInputEntity).insert(toRow<RunInputEntity>(input));
      await this.outbox.append(em, integrationEvents);
    });
  }

  async saveRunAndEvents(
    run: Run,
    events: Array<{ type: string; payload: Json }>,
    integrationEvents: IntegrationEvent[] = [],
  ): Promise<RunEvent[]> {
    return this.uow.withTx(async (em) => {
      await em.getRepository(RunEntity).update({ id: run.id }, toRow<RunEntity>(run.snapshot()));

      let appended: RunEvent[] = [];
      const outboxEvents = [...integrationEvents];
      if (events.length > 0) {
        const [row]: Array<{ last: string }> = await em.query(
          `SELECT COALESCE(MAX(seq), 0) AS last FROM run_events WHERE run_id = $1`,
          [run.id],
        );
        let seq = Number(row!.last);
        const ts = new Date();
        appended = events.map((e) => ({ runId: run.id, seq: ++seq, ts, ...e }));
        await em
          .getRepository(RunEventEntity)
          .insert(toRows<RunEventEntity>(appended.map((e) => ({ ...e }))));
        outboxEvents.push({
          aggregateType: 'run',
          aggregateId: run.id,
          eventType: EventTypes.RunEventAppended,
          payload: { seqs: appended.map((e) => e.seq) },
        });
      }
      await this.outbox.append(em, outboxEvents);
      return appended;
    });
  }

  async flowRunIdFor(runId: string): Promise<string | null> {
    const rows: Array<{ flow_run_id: string }> = await this.uow.withTx((em) =>
      em.query(`SELECT flow_run_id FROM flow_steps WHERE run_id = $1 LIMIT 1`, [runId]),
    );
    return rows[0]?.flow_run_id ?? null;
  }
}
