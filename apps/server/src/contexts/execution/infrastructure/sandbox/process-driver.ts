import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Injectable } from '@nestjs/common';
import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProcess,
} from '@agentforge/core';
import type { Sandbox, SandboxDriver, SandboxOptions } from '../../domain/sandbox';

/** Wraps a node child process as a streaming SandboxProcess. */
export function wrapChildProcess(child: ReturnType<typeof spawn>): SandboxProcess {
  function chunks(stream: NodeJS.ReadableStream | null): AsyncIterable<string> {
    return (async function* () {
      if (!stream) return;
      for await (const chunk of stream) yield chunk.toString();
    })();
  }
  const exit = new Promise<number>((resolve) => {
    child.on('close', (code) => resolve(code ?? -1));
    child.on('error', () => resolve(127));
  });
  return {
    writeStdin: (data: string) => {
      child.stdin?.write(data);
    },
    endStdin: () => child.stdin?.end(),
    stdout: chunks(child.stdout),
    stderr: chunks(child.stderr),
    wait: () => exit,
    kill: (signal = 'TERM') => {
      child.kill(signal === 'KILL' ? 'SIGKILL' : 'SIGTERM');
    },
  };
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Resolves a sandbox-relative path and refuses escapes from the workdir. */
function resolveInside(workdir: string, p: string): string {
  const resolved = path.resolve(workdir, p);
  if (resolved !== workdir && !resolved.startsWith(workdir + path.sep)) {
    throw new Error(`path escapes sandbox: ${p}`);
  }
  return resolved;
}

class ProcessSandbox implements Sandbox {
  constructor(
    readonly workdir: string,
    private readonly baseEnv: Record<string, string>,
  ) {}

  async exec(command: string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    const [cmd, ...args] = command;
    if (!cmd) throw new Error('empty command');
    const cwd = options.cwd ? resolveInside(this.workdir, options.cwd) : this.workdir;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<SandboxExecResult>((resolve) => {
      const child = spawn(cmd, args, {
        cwd,
        env: { PATH: process.env.PATH ?? '', HOME: this.workdir, ...this.baseEnv, ...options.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ exitCode: 127, stdout, stderr: `${stderr}\n${String(error)}`, timedOut });
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
      cwd: options.cwd ? resolveInside(this.workdir, options.cwd) : this.workdir,
      env: { PATH: process.env.PATH ?? '', HOME: this.workdir, ...this.baseEnv, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return wrapChildProcess(child);
  }

  async readFile(p: string): Promise<string> {
    return readFile(resolveInside(this.workdir, p), 'utf8');
  }

  async writeFile(p: string, content: string): Promise<void> {
    const target = resolveInside(this.workdir, p);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }

  async destroy(): Promise<void> {
    // Workdir lifecycle is owned by the caller (worktrees survive runs, §5.4).
  }
}

/** Dev/test driver (§11.3): child processes in the workdir. Same adapter code as docker. */
@Injectable()
export class ProcessSandboxDriver implements SandboxDriver {
  readonly id = 'process' as const;

  async create(options: SandboxOptions): Promise<Sandbox> {
    await mkdir(options.workdir, { recursive: true });
    return new ProcessSandbox(options.workdir, options.env ?? {});
  }
}
