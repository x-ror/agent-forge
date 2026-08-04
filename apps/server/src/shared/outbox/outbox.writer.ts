import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { toRows } from '../../database/row';
import { OutboxEventEntity } from './outbox-event.entity';
import type { IntegrationEvent } from './integration-event';

/**
 * Appends integration events INSIDE the caller's transaction — the only
 * legal way to produce cross-process effects (architecture invariant #2).
 */
@Injectable()
export class OutboxWriter {
  async append(em: EntityManager, events: IntegrationEvent[]): Promise<void> {
    if (events.length === 0) return;
    await em.getRepository(OutboxEventEntity).insert(
      toRows<OutboxEventEntity>(
        events.map((event) => ({
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          eventType: event.eventType,
          payload: event.payload,
          createdAt: new Date(),
          dispatchedAt: null,
        })),
      ),
    );
  }
}
