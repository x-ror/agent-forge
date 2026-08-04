import { Injectable } from '@nestjs/common';
import type { AgentAdapter } from '@agentforge/core';

/** Installed adapters, keyed by id; populated at boot (worker) / per §6.5. */
@Injectable()
export class AdapterRegistry {
  private readonly adapters = new Map<string, AgentAdapter>();

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): AgentAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }
}
