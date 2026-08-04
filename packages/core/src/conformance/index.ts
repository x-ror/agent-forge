import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AgentEvent, AgentHandle, AgentRunConfig, RunContext, SandboxExecOptions, SandboxExecResult, SandboxHandle, SandboxProcess } from '../index';

/**
 * Conformance test kit (§6.5): a real local sandbox + event collectors so
 * every adapter can be exercised against the golden scenarios (event
 * sequence, permission gate, clean cancellation, structured output).
 * Node-only — exported via `@agentforge/core/conformance`, never from the
 * package root.
 */

export class LocalSandbox implements SandboxHandle {
  private constructor(
    readonly workdir: string,
    private readonly baseEnv: Record<string, string>,
  ) {}

  static async create(env: Record<string, string> = {}): Promise<LocalSandbox> {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'agentforge-conformance-'));
    return new LocalSandbox(workdir, env);
  }

  private resolveInside(p: string): string {
    const resolved = path.resolve(this.workdir, p);
    if (resolved !== this.workdir && !resolved.startsWith(this.workdir + path.sep)) {
      throw new Error(`path escapes sandbox: ${p}`);
    }
    return resolved;
  }

  async exec(command: string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    const [cmd, ...args] = command;
    if (!cmd) throw new Error('empty command');
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        cwd: options.cwd ? this.resolveInside(options.cwd) : this.workdir,
        env: { PATH: process.env.PATH ?? '', HOME: this.workdir, ...this.baseEnv, ...options.env },
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, options.timeoutMs ?? 60_000);
      child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
      child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, stdout, stderr: String(error), timedOut });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code ?? -1, stdout, stderr, timedOut });
      });
      if (options.stdin !== undefined) child.stdin.write(options.stdin);
      child.stdin.end();
    });
  }

  async spawn(command: string[], options: SandboxExecOptions = {}): Promise<SandboxProcess> {
    const [cmd, ...args] = command;
    if (!cmd) throw new Error('empty command');
    const child = spawn(cmd, args, {
      cwd: this.workdir,
      env: { PATH: process.env.PATH ?? '', HOME: this.workdir, ...this.baseEnv, ...options.env },
    });

    function chunks(stream: NodeJS.ReadableStream): AsyncIterable<string> {
      return (async function* () {
        for await (const chunk of stream) yield chunk.toString();
      })();
    }

    const exit = new Promise<number>((resolve) => {
      child.on('close', (code) => resolve(code ?? -1));
      child.on('error', () => resolve(127));
    });

    return {
      writeStdin: (data: string) => {
        child.stdin.write(data);
      },
      endStdin: () => child.stdin.end(),
      stdout: chunks(child.stdout),
      stderr: chunks(child.stderr),
      wait: () => exit,
      kill: (signal = 'TERM') => {
        child.kill(signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
      },
    };
  }

  async readFile(p: string): Promise<string> {
    return readFile(this.resolveInside(p), 'utf8');
  }

  async writeFile(p: string, content: string): Promise<void> {
    const target = this.resolveInside(p);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

export interface MakeContextArgs {
  prompt?: string;
  sandbox: SandboxHandle;
  env?: Record<string, string>;
  config?: AgentRunConfig;
  structuredRoutes?: string[];
}

export function makeRunContext(args: MakeContextArgs): RunContext {
  return {
    runId: `conformance-${Math.random().toString(36).slice(2, 10)}`,
    prompt: args.prompt ?? 'do the task',
    config: args.config ?? {},
    env: args.env ?? {},
    sandbox: args.sandbox,
    ...(args.structuredRoutes ? { structured: { routes: args.structuredRoutes } } : {}),
  };
}

export interface CollectOptions {
  timeoutMs?: number;
  onEvent?: (event: AgentEvent) => void | Promise<void>;
  /** Stop consuming early once this returns true (stream keeps its own end). */
  until?: (events: AgentEvent[]) => boolean;
}

/** Drains an adapter handle's event stream with a hard timeout. */
export async function collectEvents(handle: AgentHandle, options: CollectOptions = {}): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const timeoutMs = options.timeoutMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  const iterator = handle.events[Symbol.asyncIterator]();
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next === 'timeout') {
        throw new Error(`collectEvents timed out after ${timeoutMs}ms; got: ${events.map((e) => e.type).join(', ')}`);
      }
      if (next.done) break;
      events.push(next.value);
      await options.onEvent?.(next.value);
      if (options.until?.(events)) break;
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
  return events;
}

/** Asserts that `expected` event types occur in order (other events may interleave). */
export function expectEventOrder(events: AgentEvent[], expected: string[]): void {
  const types: string[] = events.map((e) => e.type);
  let index = 0;
  for (const want of expected) {
    const found = types.indexOf(want, index);
    if (found < 0) {
      throw new Error(`conformance: expected '${want}' after position ${index}; got sequence: ${types.join(' → ')}`);
    }
    index = found + 1;
  }
}

export * from './mock-llm';
