import { execFile } from 'node:child_process';
import { Injectable } from '@nestjs/common';
import { ScmError } from '../domain/scm';

const GIT_TIMEOUT_MS = 120_000;

@Injectable()
export class GitCli {
  async run(
    args: string[],
    opts: { cwd?: string; env?: Record<string, string>; allowFail?: boolean } = {},
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      execFile(
        'git',
        args,
        {
          cwd: opts.cwd,
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_AUTHOR_NAME: 'AgentForge',
            GIT_AUTHOR_EMAIL: 'agentforge@localhost',
            GIT_COMMITTER_NAME: 'AgentForge',
            GIT_COMMITTER_EMAIL: 'agentforge@localhost',
            ...opts.env,
          },
        },
        (error, stdout, stderr) => {
          const exitCode = error ? ((error as { code?: number }).code ?? 1) : 0;
          if (error && !opts.allowFail) {
            reject(
              new ScmError(
                `git ${args.slice(0, 3).join(' ')} failed (exit ${exitCode}): ${stderr.slice(0, 500)}`,
                stderr,
              ),
            );
            return;
          }
          resolve({ exitCode: typeof exitCode === 'number' ? exitCode : 1, stdout, stderr });
        },
      );
    });
  }
}
