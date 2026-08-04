import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  createAgentRequestSchema,
  updateAgentRequestSchema,
  type AgentDto,
  type CreateAgentRequest,
  type UpdateAgentRequest,
} from '@agentforge/core';
import { CurrentUser, type AuthUser } from '../../../shared/http/auth.decorators';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import type { Agent } from '../domain/agent';
import { AdapterRegistry } from '../application/adapter-registry';
import { AgentsService } from '../application/agents.service';

function toDto(agent: Agent): AgentDto {
  return {
    id: agent.id,
    name: agent.name,
    adapter: agent.adapter,
    config: agent.config as Record<string, unknown>,
    createdAt: agent.createdAt.toISOString(),
  };
}

@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<AgentDto[]> {
    return (await this.agents.list(user.userId)).map(toDto);
  }

  @Post()
  async create(
    @CurrentUser() user: AuthUser,
    @Body(new ZodValidationPipe(createAgentRequestSchema)) body: CreateAgentRequest,
  ): Promise<AgentDto> {
    return toDto(await this.agents.create(user.userId, body));
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<AgentDto> {
    return toDto(await this.agents.getOwned(user.userId, id));
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(updateAgentRequestSchema)) body: UpdateAgentRequest,
  ): Promise<AgentDto> {
    return toDto(await this.agents.update(user.userId, id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.agents.delete(user.userId, id);
  }
}

/** §9: installed adapters + declared capabilities (drives canvas/UI gating). */
@Controller('adapters')
export class AdaptersController {
  constructor(private readonly registry: AdapterRegistry) {}

  @Get()
  list(): Array<{ id: string; capabilities: Record<string, boolean> }> {
    return this.registry.list().map((adapter) => ({
      id: adapter.id,
      capabilities: adapter.capabilities as unknown as Record<string, boolean>,
    }));
  }
}
