import { spawn } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import type { ShellPort } from '../domain/ports';

const OUTPUT_CAP = 20_000;

/**
 * Quality-gate command execution: `sh -c` in the flow worktree, stdout+stderr
 * merged and tail-capped so fixer prompts stay bounded. No project secrets in
 * the environment — gates are build/test commands, not deploys.
 */
@Injectable()
export class LocalShellAdapter implements ShellPort {
  run(command: string, cwd: string, timeoutMs: number): Promise<{ code: number; output: string }> {
    return new Promise((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '/tmp', CI: '1' },
      });
      let output = '';
      const append = (chunk: Buffer) => {
        output += chunk.toString('utf8');
        if (output.length > OUTPUT_CAP * 2) output = output.slice(-OUTPUT_CAP * 2);
      };
      child.stdout.on('data', append);
      child.stderr.on('data', append);
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        output += `\n[agentforge] command timed out after ${Math.round(timeoutMs / 1000)}s`;
      }, timeoutMs);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 124, output: output.slice(-OUTPUT_CAP) });
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        resolve({ code: 127, output: `${output}\n${String(error)}`.slice(-OUTPUT_CAP) });
      });
    });
  }
}
