import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import type { Project, ProjectSettings, Secret } from '../domain/project';
import type { ProjectRepository, SecretRepository } from '../domain/repositories';
import { ProjectEntity, SecretEntity } from './entities';

function toDomain(entity: ProjectEntity): Project {
  return { ...entity, settings: entity.settings as ProjectSettings };
}

@Injectable()
export class TypeormProjectRepository implements ProjectRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(project: Project): Promise<void> {
    await this.ds.getRepository(ProjectEntity).insert({ ...project });
  }

  async save(project: Project): Promise<void> {
    await this.ds.getRepository(ProjectEntity).update({ id: project.id }, { ...project });
  }

  async findById(id: string): Promise<Project | null> {
    const entity = await this.ds.getRepository(ProjectEntity).findOneBy({ id });
    return entity ? toDomain(entity) : null;
  }

  async listByOwner(ownerId: string): Promise<Project[]> {
    const rows = await this.ds.getRepository(ProjectEntity).find({ where: { ownerId }, order: { id: 'ASC' } });
    return rows.map(toDomain);
  }

  async delete(id: string): Promise<void> {
    await this.ds.getRepository(ProjectEntity).delete({ id });
  }
}

@Injectable()
export class TypeormSecretRepository implements SecretRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async upsert(secret: Secret): Promise<void> {
    await this.ds.getRepository(SecretEntity).upsert({ ...secret }, { conflictPaths: ['projectId', 'key'] });
  }

  async find(projectId: string, key: string): Promise<Secret | null> {
    return this.ds.getRepository(SecretEntity).findOneBy({ projectId, key });
  }

  async listKeys(projectId: string): Promise<string[]> {
    const rows = await this.ds
      .getRepository(SecretEntity)
      .find({ where: { projectId }, select: ['key'], order: { key: 'ASC' } });
    return rows.map((r) => r.key);
  }

  async listByProject(projectId: string): Promise<Secret[]> {
    return this.ds.getRepository(SecretEntity).find({ where: { projectId } });
  }

  async delete(projectId: string, key: string): Promise<void> {
    await this.ds.getRepository(SecretEntity).delete({ projectId, key });
  }
}
