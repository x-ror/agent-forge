import type { GithubRepo } from './scm';

/** Port: git CLI execution (implemented by infrastructure GitCli). */
export interface GitPort {
  run(
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; allowFail?: boolean; timeoutMs?: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
export const GIT_PORT = Symbol('GitPort');

/** Port: host `gh` CLI (local execution mode) — resolves the logged-in token. */
export interface GhCliPort {
  /** Returns the gh CLI's auth token, or null when gh is absent/logged out. */
  token(): Promise<string | null>;
}
export const GH_CLI_PORT = Symbol('GhCliPort');

/** Port: GitHub REST operations with worker-held tokens. */
export interface GithubPort {
  createPullRequest(args: { apiBase?: string; token: string; repo: GithubRepo; title: string; body: string; head: string; base: string }): Promise<{ url: string; number: number }>;
  commentOnIssue(args: { apiBase?: string; token: string; repo: GithubRepo; issueNumber: number; body: string }): Promise<void>;
}
export const GITHUB_PORT = Symbol('GithubPort');
