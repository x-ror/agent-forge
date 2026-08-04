import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { APP_ENV, type AppEnv } from '../../../config/env';
import { uuidv7 } from '../../../shared/uuidv7';
import type { Project } from '../../projects/domain/project';
import { SecretProvisioningService } from '../../projects/application/projects.service';
import {
  ARTIFACT_REPOSITORY,
  type ArtifactRepository,
} from '../../execution/domain/repositories';
import {
  parseGithubRepo,
  sanitizeBranchName,
  ScmError,
  type PullRequestResult,
  type WorktreeInfo,
} from '../domain/scm';
import { GIT_PORT, GITHUB_PORT, type GitPort, type GithubPort } from '../domain/ports';

/**
 * Scm context (§8): per-project mirror → per-flow/per-run worktree; diffs
 * are `git diff <baseRef>`; push/PR happen HERE with worker-held tokens —
 * agents never see credentials.
 */
@Injectable()
export class ScmService {
  private readonly logger = new Logger(ScmService.name);

  constructor(
    @Inject(APP_ENV) private readonly env: AppEnv,
    @Inject(ARTIFACT_REPOSITORY) private readonly artifacts: ArtifactRepository,
    @Inject(GIT_PORT) private readonly git: GitPort,
    @Inject(GITHUB_PORT) private readonly github: GithubPort,
    private readonly secrets: SecretProvisioningService,
  ) {}

  mirrorPath(projectId: string): string {
    return path.join(this.env.WORKSPACES_DIR, 'mirrors', `${projectId}.git`);
  }

  worktreePath(kind: 'run' | 'flow', id: string): string {
    return path.join(this.env.WORKSPACES_DIR, 'worktrees', `${kind}-${id}`);
  }

  /** Mirror clone if absent (idempotent; clone lands via temp dir + rename). */
  async ensureMirror(project: Project): Promise<string> {
    const mirror = this.mirrorPath(project.id);
    if (existsSync(mirror)) return mirror;
    await mkdir(path.dirname(mirror), { recursive: true });
    const staging = `${mirror}.tmp-${uuidv7().slice(0, 8)}`;
    try {
      await this.git.run(['clone', '--mirror', project.repoUrl, staging]);
      await rename(staging, mirror);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      if (existsSync(mirror)) return mirror; // concurrent clone won
      throw error;
    }
    return mirror;
  }

  /**
   * repo.sync: refresh upstream branches/tags in the mirror. Deliberately no
   * prune — the mirror also carries local agentforge/* work branches that
   * live in worktrees and may not exist upstream yet.
   */
  async syncMirror(project: Project): Promise<void> {
    const mirror = await this.ensureMirror(project);
    await this.git.run([
      '-C',
      mirror,
      'fetch',
      'origin',
      '+refs/heads/*:refs/heads/*',
      '+refs/tags/*:refs/tags/*',
      // agentforge/* are OUR work branches, often checked out in worktrees.
      '^refs/heads/agentforge/*',
    ]);
  }

  /**
   * Worktree from the mirror on a fresh branch. Reuses an existing worktree
   * (recovery/resume) instead of failing.
   */
  async createWorktree(
    project: Project,
    opts: { kind: 'run' | 'flow'; id: string; name: string; baseRef: string },
  ): Promise<WorktreeInfo> {
    const mirror = await this.ensureMirror(project);
    const wtPath = this.worktreePath(opts.kind, opts.id);
    const branch = `agentforge/${sanitizeBranchName(opts.name)}`;
    if (existsSync(wtPath)) {
      return { path: wtPath, branch, baseRef: opts.baseRef };
    }
    await mkdir(path.dirname(wtPath), { recursive: true });
    const result = await this.git.run(
      ['-C', mirror, 'worktree', 'add', '-b', branch, wtPath, opts.baseRef],
      { allowFail: true },
    );
    if (result.exitCode !== 0) {
      if (/already exists/.test(result.stderr)) {
        // Branch left over from a previous attempt — reattach.
        await this.git.run(['-C', mirror, 'worktree', 'add', wtPath, branch]);
      } else {
        throw new ScmError(`worktree add failed`, result.stderr);
      }
    }
    return { path: wtPath, branch, baseRef: opts.baseRef };
  }

  /** Cumulative diff vs baseRef, including untracked files (intent-to-add). */
  async cumulativeDiff(worktree: string, baseRef: string): Promise<string> {
    await this.git.run(['-C', worktree, 'add', '-N', '.']);
    const { stdout } = await this.git.run(['-C', worktree, 'diff', '--no-color', baseRef]);
    return stdout;
  }

  /** Commit everything (agent work is snapshotted as commits, §1.2). */
  async commitAll(worktree: string, message: string): Promise<boolean> {
    await this.git.run(['-C', worktree, 'add', '-A']);
    const status = await this.git.run(['-C', worktree, 'status', '--porcelain']);
    if (status.stdout.trim() === '') return false;
    await this.git.run(['-C', worktree, 'commit', '-m', message]);
    return true;
  }

  /**
   * Post-run finalize: commit agent work and store the cumulative diff as an
   * artifact (the api serves diffs from artifacts — it has no workspaces
   * volume).
   */
  async finalizeRunWorkspace(run: {
    id: string;
    workspacePath: string | null;
    baseRef: string;
  }): Promise<{ committed: boolean; diffArtifactId: string | null }> {
    const worktree = run.workspacePath;
    if (!worktree || !existsSync(path.join(worktree, '.git'))) {
      return { committed: false, diffArtifactId: null };
    }
    const committed = await this.commitAll(worktree, `agentforge: run ${run.id}`);
    const diff = await this.cumulativeDiff(worktree, run.baseRef);
    if (diff.trim() === '') return { committed, diffArtifactId: null };
    const artifactId = uuidv7();
    await this.artifacts.insert({
      id: artifactId,
      runId: run.id,
      kind: 'diff',
      name: 'cumulative.diff',
      content: Buffer.from(diff, 'utf8'),
      path: null,
      meta: { baseRef: run.baseRef },
      createdAt: new Date(),
    });
    return { committed, diffArtifactId: artifactId };
  }

  /**
   * Push the branch and open a PR (GitHub first). Without a GitHub remote or
   * token, falls back to a patch artifact — never fails the flow for missing
   * infrastructure.
   */
  async pushAndOpenPr(args: {
    project: Project;
    runId: string;
    worktree: string;
    branch: string;
    baseRef: string;
    title: string;
    body: string;
  }): Promise<PullRequestResult> {
    const env = await this.secrets.decryptedEnv(args.project.id);
    const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
    const githubRepo = parseGithubRepo(args.project.repoUrl);

    // Push to the explicit URL: worktrees hang off a --mirror clone, whose
    // `origin` has mirror=true push semantics we must not inherit.
    let pushUrl = args.project.repoUrl;
    if (githubRepo && token) {
      pushUrl = `https://x-access-token:${encodeURIComponent(token)}@github.com/${githubRepo.owner}/${githubRepo.repo}.git`;
    }
    try {
      await this.git.run(['-C', args.worktree, 'push', pushUrl, `HEAD:refs/heads/${args.branch}`]);
    } catch (error) {
      this.logger.warn(`push failed, falling back to patch artifact: ${String(error)}`);
      return this.patchArtifact(args);
    }

    if (githubRepo && token) {
      const apiBase =
        typeof args.project.settings.githubApiUrl === 'string'
          ? args.project.settings.githubApiUrl
          : undefined;
      const pr = await this.github.createPullRequest({
        apiBase,
        token,
        repo: githubRepo,
        title: args.title,
        body: args.body,
        head: args.branch,
        base: args.baseRef,
      });
      await this.artifacts.insert({
        id: uuidv7(),
        runId: args.runId,
        kind: 'pr',
        name: `PR #${pr.number}`,
        content: null,
        path: null,
        meta: { url: pr.url, number: pr.number, branch: args.branch },
        createdAt: new Date(),
      });
      return { kind: 'pr', url: pr.url, number: pr.number, artifactId: null, branch: args.branch };
    }

    // Pushed (e.g. to a local bare remote) but no PR provider: record the branch.
    await this.artifacts.insert({
      id: uuidv7(),
      runId: args.runId,
      kind: 'pr',
      name: `branch ${args.branch}`,
      content: null,
      path: null,
      meta: { url: null, number: null, branch: args.branch },
      createdAt: new Date(),
    });
    return { kind: 'pr', url: null, number: null, artifactId: null, branch: args.branch };
  }

  private async patchArtifact(args: {
    project: Project;
    runId: string;
    worktree: string;
    branch: string;
    baseRef: string;
    title: string;
  }): Promise<PullRequestResult> {
    const { stdout } = await this.git.run([
      '-C',
      args.worktree,
      'format-patch',
      `${args.baseRef}..HEAD`,
      '--stdout',
    ]);
    const artifactId = uuidv7();
    await this.artifacts.insert({
      id: artifactId,
      runId: args.runId,
      kind: 'patch',
      name: `${sanitizeBranchName(args.title)}.patch`,
      content: Buffer.from(stdout, 'utf8'),
      path: null,
      meta: { branch: args.branch, baseRef: args.baseRef },
      createdAt: new Date(),
    });
    return { kind: 'patch', url: null, number: null, artifactId, branch: args.branch };
  }

  /** Worktree cleanup with retention (maintenance job). */
  async removeWorktree(projectId: string, worktree: string): Promise<void> {
    const mirror = this.mirrorPath(projectId);
    await this.git.run(['-C', mirror, 'worktree', 'remove', '--force', worktree], {
      allowFail: true,
    });
    await rm(worktree, { recursive: true, force: true });
    await this.git.run(['-C', mirror, 'worktree', 'prune'], { allowFail: true });
  }
}
