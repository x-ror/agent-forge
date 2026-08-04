import { execFile, spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Injectable, Logger } from '@nestjs/common';
import type {
  SandboxExecOptions,
  SandboxExecResult,
  SandboxProcess,
} from '@agentforge/core';
import type { Sandbox, SandboxDriver, SandboxOptions } from '../../domain/sandbox';
import { wrapChildProcess } from './process-driver';

const execFileAsync = promisify(execFile);
const DEFAULT_IMAGE = 'agentforge/sandbox-base';
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const WORKSPACE_MOUNT = '/workspace';

/**
 * One container per agent step (§8), driven through the docker CLI over the
 * worker's socket. The worktree is bind-mounted at /workspace; adapters see
 * the same SandboxHandle regardless of driver.
 */
class DockerSandbox implements Sandbox {
  readonly workdir = WORKSPACE_MOUNT;

  constructor(
    private readonly containerId: string,
    private readonly logger: Logger,
  ) {}

  async exec(command: string[], options: SandboxExecOptions = {}): Promise<SandboxExecResult> {
    const args = ['exec'];
    if (options.stdin !== undefined) args.push('-i');
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('-e', `${key}=${value}`);
    }
    args.push('-w', options.cwd ? `${WORKSPACE_MOUNT}/${options.cwd}` : WORKSPACE_MOUNT);
    args.push(this.containerId, ...command);

    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return new Promise<SandboxExecResult>((resolve) => {
      const child = execFile(
        'docker',
        args,
        { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          const killed = Boolean(error && 'killed' in error && error.killed);
          const code =
            error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? ((error as unknown as { code: number }).code ?? -1)
              : error
                ? -1
                : 0;
          resolve({ exitCode: killed ? 137 : code, stdout, stderr, timedOut: killed });
        },
      );
      if (options.stdin !== undefined && child.stdin) {
        child.stdin.write(options.stdin);
        child.stdin.end();
      }
    });
  }

  async spawn(command: string[], options: SandboxExecOptions = {}): Promise<SandboxProcess> {
    const args = ['exec', '-i'];
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('-e', `${key}=${value}`);
    }
    args.push('-w', options.cwd ? `${WORKSPACE_MOUNT}/${options.cwd}` : WORKSPACE_MOUNT);
    args.push(this.containerId, ...command);
    return wrapChildProcess(spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] }));
  }

  async readFile(p: string): Promise<string> {
    const result = await this.exec(['cat', p]);
    if (result.exitCode !== 0) throw new Error(`readFile ${p}: ${result.stderr}`);
    return result.stdout;
  }

  async writeFile(p: string, content: string): Promise<void> {
    const result = await this.exec(['sh', '-c', `mkdir -p "$(dirname "$1")" && cat > "$1"`, 'sh', p], {
      stdin: content,
    });
    if (result.exitCode !== 0) throw new Error(`writeFile ${p}: ${result.stderr}`);
  }

  async destroy(): Promise<void> {
    try {
      await execFileAsync('docker', ['rm', '-f', this.containerId]);
    } catch (error) {
      this.logger.warn(`failed to remove sandbox container: ${String(error)}`);
    }
  }
}

@Injectable()
export class DockerSandboxDriver implements SandboxDriver {
  readonly id = 'docker' as const;
  private readonly logger = new Logger(DockerSandboxDriver.name);

  async create(options: SandboxOptions): Promise<Sandbox> {
    await mkdir(options.workdir, { recursive: true });
    const image = options.image ?? DEFAULT_IMAGE;
    const args = [
      'run',
      '-d',
      '--label',
      `agentforge.run=${options.runId}`,
      '-v',
      `${options.workdir}:${WORKSPACE_MOUNT}`,
      '-w',
      WORKSPACE_MOUNT,
    ];
    const policy = options.networkPolicy ?? 'full';
    if (policy === 'none') args.push('--network', 'none');
    if (policy === 'llm-only') {
      // Proxy-sidecar allow-listing is a Phase 10 concern; degrade loudly.
      this.logger.warn('llm-only network policy not yet enforced; using full network');
    }
    if (options.limits?.memoryMb) args.push('--memory', `${options.limits.memoryMb}m`);
    if (options.limits?.cpus) args.push('--cpus', String(options.limits.cpus));
    args.push('--pids-limit', String(options.limits?.pids ?? 512));
    for (const [key, value] of Object.entries(options.env ?? {})) {
      args.push('-e', `${key}=${value}`);
    }
    args.push(image, 'sleep', 'infinity');

    const { stdout } = await execFileAsync('docker', args);
    return new DockerSandbox(stdout.trim(), this.logger);
  }
}
