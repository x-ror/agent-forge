import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretBox } from '../../src/shared/crypto/secret-box';
import { TypeormSecretRepository } from '../../src/contexts/projects/infrastructure/typeorm-repositories';
import { connectApp, type PgTestContext } from '../helpers/pg';
import { HttpClient, startTestApp, type TestApp } from '../helpers/app';
import type { DataSource } from 'typeorm';

const TEST_KEY = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');

describe('Phase 2 e2e: identity & projects', () => {
  let testApp: TestApp;
  let http: HttpClient;
  let appDs: DataSource;
  let pg: PgTestContext;

  beforeAll(async () => {
    testApp = await startTestApp({ AGENTFORGE_SECRET_KEY: TEST_KEY });
    pg = testApp.pg;
    http = new HttpClient(testApp.baseUrl);
    appDs = await connectApp(pg.appUrl);
  }, 240_000);

  afterAll(async () => {
    await appDs?.destroy();
    await testApp?.stop();
  });

  it('health and openapi are public', async () => {
    expect((await http.get('/health')).status).toBe(200);
    const openapi = await http.get('/openapi.json');
    expect(openapi.status).toBe(200);
    expect((openapi.body as { openapi: string }).openapi).toBe('3.1.0');
  });

  it('rejects unauthenticated access with problem+json', async () => {
    const res = await http.get('/projects');
    expect(res.status).toBe(401);
    const problem = res.body as { title: string; detail?: string; status: number };
    expect(problem.status).toBe(401);
    expect(problem.detail).toContain('authentication');
  });

  let projectId: string;

  it('register → login → create project → put secret (the DoD path)', async () => {
    const email = 'owner@agentforge.local';
    const password = 'correct-horse-battery';

    const reg = await http.post('/auth/register', { email, password });
    expect(reg.status).toBe(201);

    // Fresh client to prove login works independently of the register cookie.
    http = new HttpClient(testApp.baseUrl);
    const login = await http.post('/auth/login', { email, password });
    expect(login.status).toBe(200);

    const me = await http.get('/auth/me');
    expect(me.status).toBe(200);
    expect((me.body as { via: string }).via).toBe('session');

    const created = await http.post('/projects', {
      name: 'demo',
      repoUrl: 'https://github.com/acme/demo.git',
      defaultBranch: 'main', // explicit: the remote is fictional, don't probe it
    });
    expect(created.status).toBe(201);
    projectId = (created.body as { id: string }).id;

    const putSecret = await http.put(`/projects/${projectId}/secrets/OPENAI_API_KEY`, {
      value: 'sk-super-secret',
    });
    expect(putSecret.status).toBe(204);
  });

  it('secret value is unreadable via the API (write-only)', async () => {
    const keys = await http.get(`/projects/${projectId}/secrets`);
    expect(keys.status).toBe(200);
    expect(keys.body).toEqual({ keys: ['OPENAI_API_KEY'] });
    // There is no endpoint that returns a secret value; assert the whole
    // serialized project + secret listing never leaks the plaintext.
    const project = await http.get(`/projects/${projectId}`);
    expect(JSON.stringify([keys.body, project.body])).not.toContain('sk-super-secret');
  });

  it('worker-side service decrypts the stored ciphertext', async () => {
    const secrets = new TypeormSecretRepository(appDs);
    const stored = await secrets.find(projectId, 'OPENAI_API_KEY');
    expect(stored).not.toBeNull();
    expect(stored!.ciphertext.toString()).not.toContain('sk-super-secret');
    const box = new SecretBox(TEST_KEY);
    expect(box.decrypt(stored!.ciphertext)).toBe('sk-super-secret');
  });

  it('PATs authenticate via Bearer and can be revoked', async () => {
    const created = await http.post('/pats', { name: 'automation' });
    expect(created.status).toBe(201);
    const { id, token } = created.body as { id: string; token: string };
    expect(token).toMatch(/^agf_pat_/);

    const patClient = new HttpClient(testApp.baseUrl);
    patClient.setBearer(token);
    const me = await patClient.get('/auth/me');
    expect(me.status).toBe(200);
    expect((me.body as { via: string }).via).toBe('pat');

    await http.delete(`/pats/${id}`);
    expect((await patClient.get('/auth/me')).status).toBe(401);
  });

  it('validation failures are RFC 9457 problem+json with issue paths', async () => {
    const res = await http.post('/projects', { name: '' });
    expect(res.status).toBe(400);
    const body = res.body as { status: number; errors: Array<{ path: string }> };
    expect(body.status).toBe(400);
    expect(body.errors.some((e) => e.path === 'name')).toBe(true);
    expect(body.errors.some((e) => e.path === 'repoUrl')).toBe(true);
  });

  it('logout clears the session', async () => {
    const out = await http.post('/auth/logout');
    expect(out.status).toBe(204);
    expect((await http.get('/auth/me')).status).toBe(401);
  });
});
