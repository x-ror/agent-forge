import { execFile } from 'node:child_process';
import { Injectable, Logger } from '@nestjs/common';
import type { GhCliPort } from '../domain/ports';

/**
 * Host `gh` CLI bridge (local execution mode): the token comes from the
 * user's own `gh auth login` — nothing is stored in AgentForge.
 */
@Injectable()
export class GhCli implements GhCliPort {
  private readonly logger = new Logger(GhCli.name);

  token(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('gh', ['auth', 'token'], { timeout: 10_000 }, (error, stdout) => {
        if (error) {
          this.logger.warn(`gh auth token unavailable: ${String(error).slice(0, 200)}`);
          resolve(null);
          return;
        }
        const token = stdout.trim();
        resolve(token.length > 0 ? token : null);
      });
    });
  }
}
