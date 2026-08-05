import type { SandboxHandle } from '@agentforge/core';

/** Port: sandbox lifecycle. Implemented by process/docker drivers (infrastructure). */
export interface SandboxOptions {
  runId: string;
  /** Host directory to use as the working tree; created if absent. */
  workdir: string;
  env?: Record<string, string>;
  /** Local execution mode: don't isolate HOME — the agent CLI may use the
   *  host user's stored logins (claude). Process driver only. */
  trusted?: boolean;
  /** Docker driver only. */
  image?: string;
  networkPolicy?: 'full' | 'llm-only' | 'none';
  limits?: { memoryMb?: number; cpus?: number; pids?: number };
}

export interface Sandbox extends SandboxHandle {
  destroy(): Promise<void>;
}

export interface SandboxDriver {
  readonly id: 'process' | 'docker';
  create(options: SandboxOptions): Promise<Sandbox>;
}

export const SANDBOX_DRIVER = Symbol('SandboxDriver');
