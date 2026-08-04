import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from './api.module';
import { loadEnv } from './config/env';
import { runMigrations } from './database/migration-runner';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  // Advisory-lock-guarded; api owns migrations at boot (design §11.1).
  await runMigrations(env.DATABASE_ADMIN_URL);
  const app = await NestFactory.create(ApiModule);
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');
  console.log(`agentforge api listening on :${env.API_PORT}`);
}

void bootstrap();
