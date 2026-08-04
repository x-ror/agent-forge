import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import {
  createProjectRequestSchema,
  putSecretRequestSchema,
  secretKeyPattern,
  updateProjectRequestSchema,
  type CreateProjectRequest,
  type ProjectDto,
  type PutSecretRequest,
  type RepoAgentDto,
  type UpdateProjectRequest,
} from '@agentforge/core';
import { CurrentUser, type AuthUser } from '../../../shared/http/auth.decorators';
import { ZodValidationPipe } from '../../../shared/http/zod-validation.pipe';
import type { Project } from '../domain/project';
import { ProjectsService } from '../application/projects.service';
import { RepoAgentsService } from '../application/repo-agents.service';

function toDto(project: Project): ProjectDto {
  return {
    id: project.id,
    name: project.name,
    repoUrl: project.repoUrl,
    defaultBranch: project.defaultBranch,
    settings: project.settings,
    createdAt: project.createdAt.toISOString(),
  };
}

@Controller('projects')
export class ProjectsController {
  constructor(
    private readonly projects: ProjectsService,
    private readonly repoAgents: RepoAgentsService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser): Promise<ProjectDto[]> {
    return (await this.projects.list(user.userId)).map(toDto);
  }

  @Post()
  async create(@CurrentUser() user: AuthUser, @Body(new ZodValidationPipe(createProjectRequestSchema)) body: CreateProjectRequest): Promise<ProjectDto> {
    return toDto(await this.projects.create(user.userId, body));
  }

  @Get(':id')
  async get(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<ProjectDto> {
    return toDto(await this.projects.getOwned(user.userId, id));
  }

  @Patch(':id')
  async update(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body(new ZodValidationPipe(updateProjectRequestSchema)) body: UpdateProjectRequest): Promise<ProjectDto> {
    return toDto(await this.projects.update(user.userId, id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<void> {
    await this.projects.delete(user.userId, id);
  }

  // ---- Repo agent catalog (in-repo registry + full prompts) ----------------

  /** Lava-style `config/agents.json` entries with full prompt bodies. */
  @Get(':id/repo-agents')
  async listRepoAgents(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<RepoAgentDto[]> {
    return this.repoAgents.list(user.userId, id);
  }

  @Get(':id/repo-agents/:name')
  async getRepoAgent(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('name') name: string): Promise<RepoAgentDto> {
    return this.repoAgents.get(user.userId, id, name);
  }

  // ---- Secrets: write-only -------------------------------------------------

  @Get(':id/secrets')
  async listSecretKeys(@CurrentUser() user: AuthUser, @Param('id') id: string): Promise<{ keys: string[] }> {
    return { keys: await this.projects.listSecretKeys(user.userId, id) };
  }

  @Put(':id/secrets/:key')
  @HttpCode(204)
  async putSecret(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('key') key: string,
    @Body(new ZodValidationPipe(putSecretRequestSchema)) body: PutSecretRequest,
  ): Promise<void> {
    if (!secretKeyPattern.test(key)) {
      throw new BadRequestException('secret key must be UPPER_SNAKE_CASE');
    }
    await this.projects.putSecret(user.userId, id, key, body.value);
  }

  @Delete(':id/secrets/:key')
  @HttpCode(204)
  async deleteSecret(@CurrentUser() user: AuthUser, @Param('id') id: string, @Param('key') key: string): Promise<void> {
    await this.projects.deleteSecret(user.userId, id, key);
  }
}
