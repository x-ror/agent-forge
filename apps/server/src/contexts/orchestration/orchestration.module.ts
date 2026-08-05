import { Module } from '@nestjs/common';
import { AgentRegistryModule } from '../agent-registry/agent-registry.module';
import { executionRepositoryProviders } from '../execution/execution.module';
import { ProjectsModule } from '../projects/projects.module';
import { ScmModule } from '../scm/scm.module';
import { TaskingModule } from '../tasking/tasking.module';
import { PubSubListener } from '../../shared/sse/pubsub-listener.service';
import { FlowEngine } from './application/flow-engine.service';
import { FlowRunsService } from './application/flow-runs.service';
import { WorkflowsService } from './application/workflows.service';
import { ORCHESTRATION_TX, SHELL_PORT } from './domain/ports';
import { FLOW_RUN_REPOSITORY, FLOW_STEP_REPOSITORY, SCHEDULE_REPOSITORY, WORKFLOW_REPOSITORY } from './domain/repositories';
import { OrchestrationTxOps } from './infrastructure/orchestration-tx';
import { LocalShellAdapter } from './infrastructure/shell.adapter';
import { TypeormFlowRunRepository, TypeormFlowStepRepository, TypeormScheduleRepository, TypeormWorkflowRepository } from './infrastructure/typeorm-repositories';
import { FlowRunsController, WorkflowsController } from './interface/orchestration.controller';

@Module({
  imports: [ProjectsModule, AgentRegistryModule, TaskingModule, ScmModule],
  controllers: [WorkflowsController, FlowRunsController],
  providers: [
    WorkflowsService,
    FlowRunsService,
    FlowEngine,
    PubSubListener,
    { provide: ORCHESTRATION_TX, useClass: OrchestrationTxOps },
    { provide: SHELL_PORT, useClass: LocalShellAdapter },
    { provide: WORKFLOW_REPOSITORY, useClass: TypeormWorkflowRepository },
    { provide: FLOW_RUN_REPOSITORY, useClass: TypeormFlowRunRepository },
    { provide: FLOW_STEP_REPOSITORY, useClass: TypeormFlowStepRepository },
    { provide: SCHEDULE_REPOSITORY, useClass: TypeormScheduleRepository },
    ...executionRepositoryProviders,
  ],
  exports: [FlowEngine, FlowRunsService, WorkflowsService, WORKFLOW_REPOSITORY, ORCHESTRATION_TX],
})
export class OrchestrationModule {}
