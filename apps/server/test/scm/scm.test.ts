import http from 'node:http';
import { writeFileSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DataSource } from 'typeorm';
import { loadEnv, type AppEnv } from '../../src/config/env';
import { ScmService } from '../../src/contexts/scm/application/scm.service';
import { GitCli } from '../../src/contexts/scm/infrastructure/git-cli';
import { GithubClient } from '../../src/contexts/scm/infrastructure/github-client';
import { parseGithubRepo, sanitizeBranchName } from '../../src/contexts/scm/domain/scm';
import { SecretProvisioningService } from '../../src/contexts/projects/application/projects.service';
import { TypeormProjectRepository, TypeormSecretRepository } from '../../src/contexts/projects/infrastructure/typeorm-repositories';
import { TypeormArtifactRepository } from '../../src/contexts/execution/infrastructure/typeorm-repositories';
import { TypeormUserRepository } from '../../src/contexts/identity/infrastructure/typeorm-repositories';
import { SecretBox, type SecretBoxService } from '../../src/shared/crypto/secret-box';
import { uuidv7 } from '../../src/shared/uuidv7';
import type { Project } from '../../src/contexts/projects/domain/project';
import { connectApp, startMigratedPg, type PgTestContext } from '../helpers/pg';
import { listRemoteBranches, makeLocalRepo, remoteFileAtBranch, type LocalRepo } from '../helpers/git';

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

describe('Phase 6: Scm — mirrors, worktrees, diff, push, PR', () => {
  let pg: PgTestContext;
  let ds: DataSource;
  let scm: ScmService;
  let artifacts: TypeormArtifactRepository;
  let repo: LocalRepo;
  let project: Project;
  let runId: string;
  let env: AppEnv;

  beforeAll(async () => {
    pg = await startMigratedPg();
    ds = await connectApp(pg.appUrl);
    repo = makeLocalRepo();

    env = {
      ...loadEnv(),
      WORKSPACES_DIR: mkdtempSync(path.join(os.tmpdir(), 'agentforge-scm-ws-')),
      AGENTFORGE_SECRET_KEY: TEST_KEY,
    };
    artifacts = new TypeormArtifactRepository(ds);
    const secretBox = new SecretBox(TEST_KEY) as SecretBoxService;
    scm = new ScmService(
      env,
      artifacts,
      new GitCli(),
      new GithubClient(),
      new TypeormProjectRepository(ds),
      new SecretProvisioningService(new TypeormSecretRepository(ds), secretBox),
    );

    const users = new TypeormUserRepository(ds);
    const userId = uuidv7();
    await users.insert({ id: userId, email: 'scm@x.local', passwordHash: null, createdAt: new Date() });
    project = {
      id: uuidv7(),
      ownerId: userId,
      name: 'scm-project',
      repoUrl: repo.url,
      defaultBranch: 'main',
      settings: {},
      createdAt: new Date(),
    };
    await new TypeormProjectRepository(ds).insert(project);
    const [agent] = await ds.query(`INSERT INTO agents (owner_id, name, adapter) VALUES ($1,'A','api-loop') RETURNING id`, [userId]);
    const [run] = await ds.query(`INSERT INTO runs (project_id, agent_id, task_prompt, base_ref) VALUES ($1,$2,'x','main') RETURNING id`, [project.id, agent.id]);
    runId = run.id;
  }, 240_000);

  afterAll(async () => {
    await ds?.destroy();
    await pg?.stop();
  });

  it('branch names and github URLs parse/sanitize correctly', () => {
    expect(sanitizeBranchName('Task #123: Fix IT!')).toBe('task-123-fix-it');
    expect(parseGithubRepo('https://github.com/acme/widget.git')).toEqual({
      owner: 'acme',
      repo: 'widget',
    });
    expect(parseGithubRepo('git@github.com:acme/widget.git')).toEqual({
      owner: 'acme',
      repo: 'widget',
    });
    expect(parseGithubRepo('file:///tmp/x.git')).toBeNull();
  });

  it('mirror → worktree → fake step changes → cumulative diff → push → branch on the bare remote', async () => {
    const worktree = await scm.createWorktree(project, {
      kind: 'flow',
      id: 'flow-1',
      name: 'task-42',
      baseRef: 'main',
    });
    expect(worktree.branch).toBe('agentforge/task-42');

    // "fake step": modify + add files like an agent would.
    writeFileSync(path.join(worktree.path, 'src.txt'), 'modified by agent\n');
    writeFileSync(path.join(worktree.path, 'new-file.txt'), 'brand new\n');

    const diff = await scm.cumulativeDiff(worktree.path, 'main');
    expect(diff).toContain('modified by agent');
    expect(diff).toContain('new-file.txt');

    expect(await scm.commitAll(worktree.path, 'agent work')).toBe(true);
    expect(await scm.commitAll(worktree.path, 'noop')).toBe(false); // idempotent when clean

    const result = await scm.pushAndOpenPr({
      project,
      runId,
      worktree: worktree.path,
      branch: worktree.branch,
      baseRef: 'main',
      title: 'task-42: do things',
      body: 'automated',
    });
    // file:// remote, no GitHub: pushed branch recorded, no PR URL.
    expect(result.kind).toBe('pr');
    expect(result.url).toBeNull();
    expect(listRemoteBranches(repo)).toContain('agentforge/task-42');
    expect(remoteFileAtBranch(repo, 'agentforge/task-42', 'src.txt')).toBe('modified by agent\n');

    const recorded = await artifacts.listByRun(runId);
    expect(recorded.some((a) => a.kind === 'pr' && a.name.includes('agentforge/task-42'))).toBe(true);
  });

  it('worktree creation is idempotent (recovery reattaches)', async () => {
    const again = await scm.createWorktree(project, {
      kind: 'flow',
      id: 'flow-1',
      name: 'task-42',
      baseRef: 'main',
    });
    expect(again.path).toBe(scm.worktreePath('flow', 'flow-1'));
  });

  it('repo.sync pulls upstream updates into the mirror', async () => {
    // New commit upstream (simulate someone else pushing).
    const clone = mkdtempSync(path.join(os.tmpdir(), 'agentforge-clone-'));
    const { execFileSync } = await import('node:child_process');
    execFileSync('git', ['clone', repo.url, clone, '--quiet']);
    writeFileSync(path.join(clone, 'upstream.txt'), 'from upstream\n');
    execFileSync('git', ['add', '-A'], { cwd: clone });
    execFileSync('git', ['-c', 'user.email=u@x', '-c', 'user.name=u', 'commit', '-m', 'up'], {
      cwd: clone,
    });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: clone });

    await scm.syncMirror(project);
    const git = new GitCli();
    const { stdout } = await git.run(['-C', scm.mirrorPath(project.id), 'log', '--oneline', 'main']);
    expect(stdout).toContain('up');
  });

  it('opens a real PR against a (mocked) GitHub API when token + github remote exist', async () => {
    const prRequests: unknown[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        prRequests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/7', number: 7 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // A "github" project whose actual git remote is our local bare repo, so the
    // push succeeds while PR creation goes to the mock API.
    const ghProject: Project = {
      ...project,
      id: project.id,
      repoUrl: 'https://github.com/acme/widget.git',
      settings: { githubApiUrl: apiBase },
    };
    // Provision the worker-held token.
    const secretBox = new SecretBox(TEST_KEY);
    await new TypeormSecretRepository(ds).upsert({
      id: uuidv7(),
      projectId: project.id,
      key: 'GITHUB_TOKEN',
      ciphertext: secretBox.encrypt('ghp_mock_token'),
      createdAt: new Date(),
    });

    const worktree = await scm.createWorktree(project, {
      kind: 'flow',
      id: 'flow-pr',
      name: 'pr-flow',
      baseRef: 'main',
    });
    writeFileSync(path.join(worktree.path, 'pr-change.txt'), 'pr\n');
    await scm.commitAll(worktree.path, 'pr work');

    // Push would target github.com with the token; point it at the local bare
    // remote instead by keeping repoUrl parse for PR but pushing via origin:
    // easiest here — call with the gh project but expect the push to fail and
    // fall back? No: we want the PR path. Use a project whose push URL is
    // remapped by git's insteadOf config.
    const git = new GitCli();
    await git.run(['-C', worktree.path, 'config', `url.${repo.url}.insteadOf`, 'https://x-access-token:ghp_mock_token@github.com/acme/widget.git']);

    const result = await scm.pushAndOpenPr({
      project: ghProject,
      runId,
      worktree: worktree.path,
      branch: worktree.branch,
      baseRef: 'main',
      title: 'PR title',
      body: 'PR body',
    });
    server.close();

    expect(result.kind).toBe('pr');
    expect(result.url).toBe('https://github.com/acme/widget/pull/7');
    expect(result.number).toBe(7);
    const request = prRequests[0] as { auth: string; body: { head: string; base: string } };
    expect(request.auth).toBe('Bearer ghp_mock_token');
    expect(request.body.head).toBe('agentforge/pr-flow');
    expect(request.body.base).toBe('main');
    const recorded = await artifacts.listByRun(runId);
    expect(recorded.some((a) => a.kind === 'pr' && a.name === 'PR #7')).toBe(true);
  });

  it('falls back to a patch artifact when the push target is unreachable', async () => {
    // Non-github, nonexistent remote: push fails fast and locally.
    const badProject: Project = { ...project, repoUrl: 'file:///nonexistent/agentforge/repo.git' };
    const worktree = await scm.createWorktree(project, {
      kind: 'flow',
      id: 'flow-patch',
      name: 'patch-flow',
      baseRef: 'main',
    });
    writeFileSync(path.join(worktree.path, 'patch-change.txt'), 'patch\n');
    await scm.commitAll(worktree.path, 'patch work');
    const result = await scm.pushAndOpenPr({
      project: badProject,
      runId,
      worktree: worktree.path,
      branch: worktree.branch,
      baseRef: 'main',
      title: 'patch title',
      body: '',
    });
    expect(result.kind).toBe('patch');
    expect(result.artifactId).not.toBeNull();
    const artifact = await artifacts.findById(result.artifactId!);
    expect(artifact?.content?.toString()).toContain('patch-change.txt');
  }, 120_000);
});
