import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface LocalRepo {
  /** file:// URL of the bare "remote". */
  url: string;
  barePath: string;
  defaultBranch: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@test',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@test',
    },
  });
}

/** Creates a bare repo with one initial commit on `branch` — the local "GitHub". */
export function makeLocalRepo(branch = 'main', opts: { empty?: boolean } = {}): LocalRepo {
  if (opts.empty) {
    // Bare repo with an unborn HEAD — no commits, no resolvable refs.
    const barePath = mkdtempSync(path.join(os.tmpdir(), 'agentforge-remote-')) + '/repo.git';
    git(path.dirname(barePath), 'init', '--bare', '-b', branch, barePath);
    return { url: `file://${barePath}`, barePath, defaultBranch: branch };
  }
  const work = mkdtempSync(path.join(os.tmpdir(), 'agentforge-fixture-'));
  git(work, 'init', '-b', branch);
  writeFileSync(path.join(work, 'README.md'), '# fixture\n');
  writeFileSync(path.join(work, 'src.txt'), 'original content\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-m', 'initial commit');

  const barePath = mkdtempSync(path.join(os.tmpdir(), 'agentforge-remote-')) + '/repo.git';
  git(work, 'clone', '--bare', work, barePath);
  return { url: `file://${barePath}`, barePath, defaultBranch: branch };
}

export function listRemoteBranches(repo: LocalRepo): string[] {
  return git(repo.barePath, 'branch', '--format=%(refname:short)')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function remoteFileAtBranch(repo: LocalRepo, branch: string, file: string): string {
  return git(repo.barePath, 'show', `${branch}:${file}`);
}
