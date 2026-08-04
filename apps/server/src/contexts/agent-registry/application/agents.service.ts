import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateAgentRequest, UpdateAgentRequest } from '@agentforge/core';
import { uuidv7 } from '../../../shared/uuidv7';
import { AGENT_REPOSITORY, type Agent, type AgentConfig, type AgentRepository, type AdapterId } from '../domain/agent';
import { AdapterRegistry } from './adapter-registry';

@Injectable()
export class AgentsService {
  constructor(
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    private readonly registry: AdapterRegistry,
  ) {}

  async create(ownerId: string, input: CreateAgentRequest): Promise<Agent> {
    if (!this.registry.get(input.adapter)) {
      throw new BadRequestException(`adapter '${input.adapter}' is not installed`);
    }
    if (await this.agents.findByOwnerAndName(ownerId, input.name)) {
      throw new ConflictException(`agent '${input.name}' already exists`);
    }
    const agent: Agent = {
      id: uuidv7(),
      ownerId,
      name: input.name,
      adapter: input.adapter as AdapterId,
      config: input.config as AgentConfig,
      createdAt: new Date(),
    };
    await this.agents.insert(agent);
    return agent;
  }

  async list(ownerId: string): Promise<Agent[]> {
    return this.agents.listByOwner(ownerId);
  }

  async getOwned(ownerId: string, agentId: string): Promise<Agent> {
    const agent = await this.agents.findById(agentId);
    if (!agent || agent.ownerId !== ownerId) throw new NotFoundException('agent not found');
    return agent;
  }

  async update(ownerId: string, agentId: string, input: UpdateAgentRequest): Promise<Agent> {
    const agent = await this.getOwned(ownerId, agentId);
    if (input.adapter && !this.registry.get(input.adapter)) {
      throw new BadRequestException(`adapter '${input.adapter}' is not installed`);
    }
    const updated: Agent = {
      ...agent,
      name: input.name ?? agent.name,
      adapter: (input.adapter as AdapterId | undefined) ?? agent.adapter,
      config: (input.config as AgentConfig | undefined) ?? agent.config,
    };
    await this.agents.save(updated);
    return updated;
  }

  async delete(ownerId: string, agentId: string): Promise<void> {
    await this.getOwned(ownerId, agentId);
    await this.agents.delete(agentId);
  }
}
