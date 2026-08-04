import type { Json } from '@agentforge/core';

export interface ProjectSettings {
  /** Commands the agent may run without a permission gate. */
  allowedCommands?: string[];
  /** Sandbox network policy: full | llm-only | none (§8). */
  networkPolicy?: 'full' | 'llm-only' | 'none';
  /** Custom sandbox image; defaults to agentforge/sandbox-base. */
  sandboxImage?: string;
  /** Default agent id for quick runs. */
  defaultAgentId?: string;
  [key: string]: Json | undefined;
}

export interface Project {
  id: string;
  ownerId: string;
  name: string;
  repoUrl: string;
  defaultBranch: string;
  settings: ProjectSettings;
  createdAt: Date;
}

/** Write-only secret: the plaintext exists only in worker memory (§12). */
export interface Secret {
  id: string;
  projectId: string;
  key: string;
  ciphertext: Buffer;
  createdAt: Date;
}
