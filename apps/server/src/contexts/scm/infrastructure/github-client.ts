import { Injectable } from '@nestjs/common';
import { ScmError, type GithubRepo } from '../domain/scm';

/**
 * Minimal GitHub REST client (fetch-based, worker-held tokens only — §12:
 * agents never hold push credentials).
 */
@Injectable()
export class GithubClient {
  async createPullRequest(args: {
    apiBase?: string;
    token: string;
    repo: GithubRepo;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<{ url: string; number: number }> {
    const apiBase = (args.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    const res = await fetch(`${apiBase}/repos/${args.repo.owner}/${args.repo.repo}/pulls`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${args.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'agentforge',
      },
      body: JSON.stringify({
        title: args.title,
        body: args.body,
        head: args.head,
        base: args.base,
      }),
    });
    if (!res.ok) {
      throw new ScmError(`github create PR failed: ${res.status}`, await res.text());
    }
    const body = (await res.json()) as { html_url: string; number: number };
    return { url: body.html_url, number: body.number };
  }

  async commentOnIssue(args: {
    apiBase?: string;
    token: string;
    repo: GithubRepo;
    issueNumber: number;
    body: string;
  }): Promise<void> {
    const apiBase = (args.apiBase ?? 'https://api.github.com').replace(/\/$/, '');
    const res = await fetch(
      `${apiBase}/repos/${args.repo.owner}/${args.repo.repo}/issues/${args.issueNumber}/comments`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${args.token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'user-agent': 'agentforge',
        },
        body: JSON.stringify({ body: args.body }),
      },
    );
    if (!res.ok) {
      throw new ScmError(`github comment failed: ${res.status}`, await res.text());
    }
  }
}
