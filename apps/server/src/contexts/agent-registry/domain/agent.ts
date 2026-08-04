import type { Json } from '@agentforge/core';

export type AdapterId = 'claude-code' | 'codex-cli' | 'openhands' | 'aider' | 'api-loop';

export interface AgentConfig {
  model?: string;
  /** Full role/prompt text imported from a project repo agent registry. */
  systemPrompt?: string;
  /** Adapter-specific flags/options. */
  options?: Record<string, Json>;
  [key: string]: Json | undefined;
}

/** A registered runtime configuration ("Implementer", "Reviewer", …). */
export interface Agent {
  id: string;
  ownerId: string;
  name: string;
  adapter: AdapterId;
  config: AgentConfig;
  createdAt: Date;
}

export interface AgentRepository {
  insert(agent: Agent): Promise<void>;
  save(agent: Agent): Promise<void>;
  findById(id: string): Promise<Agent | null>;
  findByOwnerAndName(ownerId: string, name: string): Promise<Agent | null>;
  listByOwner(ownerId: string): Promise<Agent[]>;
  delete(id: string): Promise<void>;
}

export const AGENT_REPOSITORY = Symbol('AgentRepository');
