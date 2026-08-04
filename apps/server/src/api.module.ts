import { Module } from '@nestjs/common';
import { IdentityModule } from './contexts/identity/identity.module';
import { ProjectsModule } from './contexts/projects/projects.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { EnvModule } from './shared/env.module';
import { OpenApiController } from './shared/openapi/openapi.controller';

@Module({
  imports: [EnvModule, DatabaseModule, IdentityModule, ProjectsModule],
  controllers: [HealthController, OpenApiController],
})
export class ApiModule {}
