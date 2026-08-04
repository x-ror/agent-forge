import { Module } from '@nestjs/common';
import { AdapterRegistry } from './application/adapter-registry';
import { AGENT_REPOSITORY } from './domain/agent';
import { TypeormAgentRepository } from './infrastructure/typeorm-repositories';

@Module({
  providers: [AdapterRegistry, { provide: AGENT_REPOSITORY, useClass: TypeormAgentRepository }],
  exports: [AdapterRegistry, AGENT_REPOSITORY],
})
export class AgentRegistryModule {}
