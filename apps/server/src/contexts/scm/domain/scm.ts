export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
}

export interface PullRequestResult {
  kind: 'pr' | 'patch';
  /** Present when kind = 'pr'. */
  url: string | null;
  number: number | null;
  /** Present when kind = 'patch' (no remote / no token fallback). */
  artifactId: string | null;
  branch: string;
}

export class ScmError extends Error {
  constructor(
    message: string,
    public readonly stderr?: string,
  ) {
    super(message);
    this.name = 'ScmError';
  }
}

/** github.com repo coordinates parsed from a remote URL. */
export interface GithubRepo {
  owner: string;
  repo: string;
}

export function parseGithubRepo(repoUrl: string): GithubRepo | null {
  const https = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(repoUrl);
  if (https) return { owner: https[1]!, repo: https[2]! };
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/.exec(repoUrl);
  if (ssh) return { owner: ssh[1]!, repo: ssh[2]! };
  return null;
}

/** Web URL for a git remote: git@gitlab.co.com:grp/app.git → https://gitlab.co.com/grp/app */
export function remoteWebUrl(remote: string): string | null {
  const ssh = /^(?:ssh:\/\/)?git@([^:/]+)[:/](.+?)(?:\.git)?\/?$/.exec(remote);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const https = /^https:\/\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote);
  if (https) return `https://${https[1]}/${https[2]}`;
  return null;
}

/** GitLab's create-MR page for a branch — the fallback when the push output has no link. */
export function mergeRequestNewUrl(remote: string, branch: string): string | null {
  const web = remoteWebUrl(remote);
  return web ? `${web}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(branch)}` : null;
}

export function sanitizeBranchName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9/_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/\/{2,}/g, '/')
      .slice(0, 60) || 'work'
  );
}
