import { Module } from '@nestjs/common';
import { AgentRegistryModule } from '../agent-registry/agent-registry.module';
import { ProjectsModule } from '../projects/projects.module';
import { ScmModule } from '../scm/scm.module';
import { APP_ENV, type AppEnv } from '../../config/env';
import { RunOrchestrator } from './application/run-orchestrator';
import { executionRepositoryProviders } from './execution.module';
import { DockerSandboxDriver } from './infrastructure/sandbox/docker-driver';
import { ProcessSandboxDriver } from './infrastructure/sandbox/process-driver';
import { SANDBOX_DRIVER } from './domain/sandbox';

/** Worker-side execution module: the run orchestrator + sandbox drivers. */
@Module({
  imports: [ProjectsModule, AgentRegistryModule, ScmModule],
  providers: [
    RunOrchestrator,
    ...executionRepositoryProviders,
    ProcessSandboxDriver,
    DockerSandboxDriver,
    {
      provide: SANDBOX_DRIVER,
      inject: [APP_ENV, ProcessSandboxDriver, DockerSandboxDriver],
      useFactory: (env: AppEnv, proc: ProcessSandboxDriver, docker: DockerSandboxDriver) =>
        env.SANDBOX_DRIVER === 'docker' ? docker : proc,
    },
  ],
  exports: [RunOrchestrator],
})
export class ExecutionWorkerModule {}
