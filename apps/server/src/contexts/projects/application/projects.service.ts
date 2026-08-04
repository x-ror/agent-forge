import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateProjectRequest, UpdateProjectRequest } from '@agentforge/core';
import { uuidv7 } from '../../../shared/uuidv7';
import type { Project, ProjectSettings } from '../domain/project';
import { PROJECT_REPOSITORY, SECRET_REPOSITORY, type ProjectRepository, type SecretRepository } from '../domain/repositories';
import { SecretBoxService } from '../../../shared/crypto/secret-box';

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(PROJECT_REPOSITORY) private readonly projects: ProjectRepository,
    @Inject(SECRET_REPOSITORY) private readonly secrets: SecretRepository,
    private readonly secretBox: SecretBoxService,
  ) {}

  async create(ownerId: string, input: CreateProjectRequest): Promise<Project> {
    const project: Project = {
      id: uuidv7(),
      ownerId,
      name: input.name,
      repoUrl: input.repoUrl,
      defaultBranch: input.defaultBranch,
      settings: input.settings as ProjectSettings,
      createdAt: new Date(),
    };
    await this.projects.insert(project);
    return project;
  }

  async list(ownerId: string): Promise<Project[]> {
    return this.projects.listByOwner(ownerId);
  }

  /** Loads a project and enforces ownership — the tenancy boundary for v1. */
  async getOwned(ownerId: string, projectId: string): Promise<Project> {
    const project = await this.projects.findById(projectId);
    if (!project) throw new NotFoundException('project not found');
    if (project.ownerId !== ownerId) throw new ForbiddenException('not your project');
    return project;
  }

  async update(ownerId: string, projectId: string, input: UpdateProjectRequest): Promise<Project> {
    const project = await this.getOwned(ownerId, projectId);
    const updated: Project = {
      ...project,
      name: input.name ?? project.name,
      repoUrl: input.repoUrl ?? project.repoUrl,
      defaultBranch: input.defaultBranch ?? project.defaultBranch,
      settings: (input.settings as ProjectSettings | undefined) ?? project.settings,
    };
    await this.projects.save(updated);
    return updated;
  }

  async delete(ownerId: string, projectId: string): Promise<void> {
    await this.getOwned(ownerId, projectId);
    await this.projects.delete(projectId);
  }

  // ---- Secrets (write-only API §9) ----------------------------------------

  async putSecret(ownerId: string, projectId: string, key: string, value: string): Promise<void> {
    await this.getOwned(ownerId, projectId);
    await this.secrets.upsert({
      id: uuidv7(),
      projectId,
      key,
      ciphertext: this.secretBox.encrypt(value),
      createdAt: new Date(),
    });
  }

  async deleteSecret(ownerId: string, projectId: string, key: string): Promise<void> {
    await this.getOwned(ownerId, projectId);
    await this.secrets.delete(projectId, key);
  }

  async listSecretKeys(ownerId: string, projectId: string): Promise<string[]> {
    await this.getOwned(ownerId, projectId);
    return this.secrets.listKeys(projectId);
  }
}

/**
 * Worker-side decryption: resolves a project's secrets to plaintext env.
 * Never exposed over HTTP; used at sandbox provisioning time only (§8).
 */
@Injectable()
export class SecretProvisioningService {
  constructor(
    @Inject(SECRET_REPOSITORY) private readonly secrets: SecretRepository,
    private readonly secretBox: SecretBoxService,
  ) {}

  async decryptedEnv(projectId: string): Promise<Record<string, string>> {
    const rows = await this.secrets.listByProject(projectId);
    const env: Record<string, string> = {};
    for (const row of rows) {
      env[row.key] = this.secretBox.decrypt(row.ciphertext);
    }
    return env;
  }
}
