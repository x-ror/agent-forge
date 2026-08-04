import { Module } from '@nestjs/common';
import { HealthController } from './health/health.controller';
import { EnvModule } from './shared/env.module';

@Module({
  imports: [EnvModule],
  controllers: [HealthController],
})
export class ApiModule {}
