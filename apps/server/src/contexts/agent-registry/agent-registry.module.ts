import { Module } from '@nestjs/common';
import { installAdapters } from '../../adapters/install';
import { AdapterRegistry } from './application/adapter-registry';
import { AgentsService } from './application/agents.service';
import { AGENT_REPOSITORY } from './domain/agent';
import { TypeormAgentRepository } from './infrastructure/typeorm-repositories';
import { AdaptersController, AgentsController } from './interface/agents.controller';

@Module({
  controllers: [AgentsController, AdaptersController],
  providers: [
    {
      provide: AdapterRegistry,
      useFactory: (): AdapterRegistry => {
        const registry = new AdapterRegistry();
        installAdapters(registry);
        return registry;
      },
    },
    AgentsService,
    { provide: AGENT_REPOSITORY, useClass: TypeormAgentRepository },
  ],
  exports: [AdapterRegistry, AgentsService, AGENT_REPOSITORY],
})
export class AgentRegistryModule {}
