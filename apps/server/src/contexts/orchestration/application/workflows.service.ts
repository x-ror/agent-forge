import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { collectReferencedAgents, workflowDefinitionSchema, type WorkflowDefinition } from '@agentforge/core';
import { uuidv7 } from '../../../shared/uuidv7';
import { AdapterRegistry } from '../../agent-registry/application/adapter-registry';
import { AGENT_REPOSITORY, type AgentRepository } from '../../agent-registry/domain/agent';
import { ProjectsService } from '../../projects/application/projects.service';
import { WORKFLOW_REPOSITORY, type WorkflowRepository } from '../domain/repositories';
import type { Workflow } from '../domain/workflow';

@Injectable()
export class WorkflowsService {
  constructor(
    @Inject(WORKFLOW_REPOSITORY) private readonly workflows: WorkflowRepository,
    @Inject(AGENT_REPOSITORY) private readonly agents: AgentRepository,
    private readonly registry: AdapterRegistry,
    private readonly projects: ProjectsService,
  ) {}

  /**
   * Shared-schema validation (shape + graph) plus the server-only checks:
   * referenced agents exist and decision.agent nodes bind to adapters that
   * declare structuredOutput (§6.1).
   */
  private async validateDefinition(ownerId: string, raw: unknown): Promise<WorkflowDefinition> {
    const parsed = workflowDefinitionSchema.safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException({
        message: 'invalid workflow definition',
        errors: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }
    const definition = parsed.data;
    for (const name of collectReferencedAgents(definition)) {
      const agent = await this.agents.findByOwnerAndName(ownerId, name);
      if (!agent) {
        throw new BadRequestException(`workflow references unknown agent "${name}"`);
      }
      const adapter = this.registry.get(agent.adapter);
      const usedForDecision = definition.nodes.some((node) => node.type === 'decision.agent' && node.agent === name);
      if (usedForDecision && !adapter?.capabilities.structuredOutput) {
        throw new BadRequestException(`agent "${name}" (adapter ${agent.adapter}) cannot back a decision node: adapter lacks structuredOutput`);
      }
    }
    return definition;
  }

  async create(ownerId: string, projectId: string, name: string, raw: unknown): Promise<Workflow> {
    await this.projects.getOwned(ownerId, projectId);
    const definition = await this.validateDefinition(ownerId, raw);
    const existing = await this.workflows.findLatestByName(projectId, name);
    const workflow: Workflow = {
      id: uuidv7(),
      projectId,
      name,
      version: (existing?.version ?? 0) + 1,
      definition,
      enabled: true,
      createdAt: new Date(),
    };
    await this.workflows.insert(workflow);
    return workflow;
  }

  /** Edit = version n+1; runs keep pinning the version they started with (§7.3). */
  async newVersion(ownerId: string, workflowId: string, raw: unknown): Promise<Workflow> {
    const current = await this.getOwned(ownerId, workflowId);
    return this.create(ownerId, current.projectId, current.name, raw);
  }

  async getOwned(ownerId: string, workflowId: string): Promise<Workflow> {
    const workflow = await this.workflows.findById(workflowId);
    if (!workflow) throw new NotFoundException('workflow not found');
    await this.projects.getOwned(ownerId, workflow.projectId);
    return workflow;
  }

  async listLatest(ownerId: string, projectId: string): Promise<Workflow[]> {
    await this.projects.getOwned(ownerId, projectId);
    return this.workflows.listLatest(projectId);
  }

  async setEnabled(ownerId: string, workflowId: string, enabled: boolean): Promise<void> {
    await this.getOwned(ownerId, workflowId);
    await this.workflows.setEnabled(workflowId, enabled);
  }
}
