import { Injectable, Logger } from '@nestjs/common';
import type { Json } from '@agentforge/core';

export interface DomainEvent {
  type: string;
  payload: Json;
}

type Handler = (event: DomainEvent) => void | Promise<void>;

/**
 * In-process bus for post-commit, same-process reactions (§2.4 tier 1).
 * Cross-process effects go through the outbox, never through this bus.
 */
@Injectable()
export class DomainEventBus {
  private readonly logger = new Logger(DomainEventBus.name);
  private readonly handlers = new Map<string, Set<Handler>>();

  on(type: string, handler: Handler): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler);
    this.handlers.set(type, set);
    return () => set.delete(handler);
  }

  async publish(events: DomainEvent[]): Promise<void> {
    for (const event of events) {
      for (const handler of this.handlers.get(event.type) ?? []) {
        try {
          await handler(event);
        } catch (error) {
          this.logger.error(`handler for ${event.type} failed: ${String(error)}`);
        }
      }
    }
  }
}
