import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ApiModule } from './api.module';
import { loadEnv } from './config/env';

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(ApiModule);
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(env.API_PORT, '0.0.0.0');
  console.log(`agentforge api listening on :${env.API_PORT}`);
}

void bootstrap();
