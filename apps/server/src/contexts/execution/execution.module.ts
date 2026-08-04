import { Module } from '@nestjs/common';
import { AgentRegistryModule } from '../agent-registry/agent-registry.module';
import { ProjectsModule } from '../projects/projects.module';
import { PubSubListener } from '../../shared/sse/pubsub-listener.service';
import { RunsService } from './application/runs.service';
import { ARTIFACT_REPOSITORY, RUN_EVENT_REPOSITORY, RUN_INPUT_REPOSITORY, RUN_REPOSITORY } from './domain/repositories';
import { TypeormArtifactRepository, TypeormRunEventRepository, TypeormRunInputRepository, TypeormRunRepository } from './infrastructure/typeorm-repositories';
import { RunTxOps } from './infrastructure/run-tx-ops';
import { RUN_TX } from './domain/ports';
import { RunsController } from './interface/runs.controller';

export const executionRepositoryProviders = [
  { provide: RUN_REPOSITORY, useClass: TypeormRunRepository },
  { provide: RUN_EVENT_REPOSITORY, useClass: TypeormRunEventRepository },
  { provide: RUN_INPUT_REPOSITORY, useClass: TypeormRunInputRepository },
  { provide: ARTIFACT_REPOSITORY, useClass: TypeormArtifactRepository },
  { provide: RUN_TX, useClass: RunTxOps },
];

/** API-side execution module: run commands/queries + SSE. */
@Module({
  imports: [ProjectsModule, AgentRegistryModule],
  controllers: [RunsController],
  providers: [RunsService, PubSubListener, ...executionRepositoryProviders],
  exports: [RunsService, ...executionRepositoryProviders],
})
export class ExecutionModule {}
