import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ApiModule } from '../../src/api.module';
import { ProblemDetailsFilter } from '../../src/shared/http/problem-details.filter';
import { startMigratedPg, type PgTestContext } from './pg';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  pg: PgTestContext;
  stop(): Promise<void>;
}

/** Boots the full api application against a fresh migrated PG container. */
export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const pg = await startMigratedPg();
  process.env.DATABASE_URL = pg.appUrl;
  process.env.DATABASE_ADMIN_URL = pg.adminUrl;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;

  const moduleRef = await Test.createTestingModule({ imports: [ApiModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ProblemDetailsFilter());
  await app.init();
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

  return {
    app,
    baseUrl,
    pg,
    stop: async () => {
      await app.close();
      await pg.stop();
    },
  };
}

/** Minimal cookie-jar fetch for session-based e2e tests. */
export class HttpClient {
  private cookie: string | undefined;

  constructor(private readonly baseUrl: string) {}

  setBearer(token: string | undefined): void {
    this.bearer = token;
  }
  private bearer: string | undefined;

  async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: unknown; headers: Headers }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cookie) headers.cookie = this.cookie;
    if (this.bearer) headers.authorization = `Bearer ${this.bearer}`;
    const res = await fetch(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  get(path: string) {
    return this.request('GET', path);
  }
  post(path: string, body?: unknown) {
    return this.request('POST', path, body);
  }
  put(path: string, body?: unknown) {
    return this.request('PUT', path, body);
  }
  patch(path: string, body?: unknown) {
    return this.request('PATCH', path, body);
  }
  delete(path: string) {
    return this.request('DELETE', path);
  }
}
