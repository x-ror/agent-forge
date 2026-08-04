import type { Json } from '../json';
import type { AgentEvent } from './agent-events';

/**
 * Adapter SDK interfaces (design doc §6.1).
 * Adapters are framework-free: they receive a RunContext (sandbox handle,
 * prompt, config, decrypted env) and expose a normalized AgentHandle.
 * Adapters get NO database access and NO Docker socket.
 */

export interface AdapterCapabilities {
  steering: boolean;
  permissionGates: boolean;
  resume: boolean;
  costReporting: boolean;
  /** Can be constrained to routes — required for decision.agent nodes. */
  structuredOutput: boolean;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

/** A long-running process inside the sandbox (CLI agents run over stdio). */
export interface SandboxProcess {
  writeStdin(data: string): void;
  endStdin(): void;
  /** Raw stdout chunks as they arrive. */
  stdout: AsyncIterable<string>;
  /** Raw stderr chunks as they arrive. */
  stderr: AsyncIterable<string>;
  /** Resolves with the exit code. */
  wait(): Promise<number>;
  kill(signal?: 'TERM' | 'KILL'): void;
}

/**
 * Handle to the sandbox in which the agent operates. Backed by either the
 * `process` driver (child processes in a temp dir) or the `docker` driver
 * (container per step); adapters cannot tell the difference.
 */
export interface SandboxHandle {
  /** Working directory of the sandbox (the flow worktree mount). */
  readonly workdir: string;
  exec(command: string[], options?: SandboxExecOptions): Promise<SandboxExecResult>;
  /** Start a long-running process with streaming stdio (CLI adapters). */
  spawn(command: string[], options?: SandboxExecOptions): Promise<SandboxProcess>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

/** Structured-output constraint for decision runs. */
export interface StructuredOutputSpec {
  routes: string[];
}

export interface AgentRunConfig {
  /** Model identifier, adapter-specific (e.g. 'claude-sonnet-5'). */
  model?: string;
  /** Adapter-specific flags/options from the registered agent's config. */
  options?: Record<string, Json>;
  /** Commands the agent may run without a permission gate; empty = gate everything. */
  allowedCommands?: string[];
  /** Wall-clock budget for the run. */
  timeoutMs?: number;
}

export interface RunContext {
  runId: string;
  prompt: string;
  config: AgentRunConfig;
  /** Decrypted env (secrets) injected at provisioning time — never persisted. */
  env: Record<string, string>;
  sandbox: SandboxHandle;
  /** Present when this run backs a decision.agent node. */
  structured?: StructuredOutputSpec;
}

export interface UserMessage {
  text: string;
}

export type StopReason = 'cancelled' | 'timeout' | 'shutdown';

/** Opaque adapter-specific resume state, persisted by the orchestrator. */
export interface ResumeState {
  data: Json;
}

export interface AgentHandle {
  /** Normalized event stream — the ONLY way agent activity reaches core. */
  events: AsyncIterable<AgentEvent>;
  /** Mid-run steering. */
  send(input: UserMessage): Promise<void>;
  respondToPermission(id: string, decision: 'allow' | 'deny', note?: string): Promise<void>;
  /** Graceful stop, then SIGKILL after grace period. */
  stop(reason: StopReason): Promise<void>;
  /**
   * Adapter-specific checkpoint the orchestrator persists for `resume`
   * (capability `resume`). Called after event batches; cheap and sync.
   */
  getResumeState?(): Json;
}

export interface AgentAdapter {
  readonly id: string; // 'claude-code' | 'codex-cli' | 'openhands' | 'aider' | 'api-loop'
  readonly capabilities: AdapterCapabilities;
  start(ctx: RunContext): Promise<AgentHandle>;
  /** Reattach after worker restart (capability `resume`). */
  resume?(ctx: RunContext, state: ResumeState): Promise<AgentHandle>;
}
