import type { GithubRepo } from './scm';

/** Port: git CLI execution (implemented by infrastructure GitCli). */
export interface GitPort {
  run(args: string[], opts?: { cwd?: string; env?: Record<string, string>; allowFail?: boolean }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}
export const GIT_PORT = Symbol('GitPort');

/** Port: GitHub REST operations with worker-held tokens. */
export interface GithubPort {
  createPullRequest(args: { apiBase?: string; token: string; repo: GithubRepo; title: string; body: string; head: string; base: string }): Promise<{ url: string; number: number }>;
  commentOnIssue(args: { apiBase?: string; token: string; repo: GithubRepo; issueNumber: number; body: string }): Promise<void>;
}
export const GITHUB_PORT = Symbol('GithubPort');
