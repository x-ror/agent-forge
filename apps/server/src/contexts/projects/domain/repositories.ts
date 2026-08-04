import type { Project, Secret } from './project';

export interface ProjectRepository {
  insert(project: Project): Promise<void>;
  save(project: Project): Promise<void>;
  findById(id: string): Promise<Project | null>;
  listByOwner(ownerId: string): Promise<Project[]>;
  delete(id: string): Promise<void>;
}

export interface SecretRepository {
  upsert(secret: Secret): Promise<void>;
  find(projectId: string, key: string): Promise<Secret | null>;
  listKeys(projectId: string): Promise<string[]>;
  listByProject(projectId: string): Promise<Secret[]>;
  delete(projectId: string, key: string): Promise<void>;
}

export const PROJECT_REPOSITORY = Symbol('ProjectRepository');
export const SECRET_REPOSITORY = Symbol('SecretRepository');
