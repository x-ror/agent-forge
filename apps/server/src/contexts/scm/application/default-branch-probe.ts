import { Inject, Injectable, Logger } from '@nestjs/common';
import { GIT_PORT, type GitPort } from '../domain/ports';

/** Project creation is an interactive HTTP call — don't sit on the default 2min. */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * Asks a remote what it actually calls its default branch.
 *
 * Guessing `main` is wrong often enough to matter (`master` is still very much
 * alive), and the guess doesn't fail at project creation — it fails much later
 * as `fatal: invalid reference: main` from `git worktree add`, by which point
 * the connection to the wrong stored value is far from obvious.
 */
@Injectable()
export class DefaultBranchProbe {
  private readonly logger = new Logger(DefaultBranchProbe.name);

  constructor(@Inject(GIT_PORT) private readonly git: GitPort) {}

  /** Remote HEAD's branch, or null when the remote can't be reached/read. */
  async detect(repoUrl: string): Promise<string | null> {
    let result;
    try {
      result = await this.git.run(['ls-remote', '--symref', repoUrl, 'HEAD'], { allowFail: true, timeoutMs: PROBE_TIMEOUT_MS });
    } catch (error) {
      this.logger.warn(`default branch probe for ${repoUrl} errored: ${String(error).slice(0, 200)}`);
      return null;
    }
    if (result.exitCode !== 0) {
      // Private repo without credentials, bad URL, network down — all fine to
      // shrug at; the caller falls back and the user can correct it later.
      this.logger.warn(`default branch probe for ${repoUrl} failed (exit ${result.exitCode}): ${result.stderr.trim().slice(0, 200)}`);
      return null;
    }
    const match = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(result.stdout);
    if (!match) {
      // Empty repo, or a remote whose HEAD isn't symbolic.
      this.logger.warn(`default branch probe for ${repoUrl} found no symbolic HEAD`);
      return null;
    }
    return match[1]!;
  }
}
