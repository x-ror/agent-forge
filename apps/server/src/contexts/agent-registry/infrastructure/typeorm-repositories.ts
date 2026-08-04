import { Inject, Injectable } from '@nestjs/common';
import type { DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import type { Agent, AgentConfig, AgentRepository, AdapterId } from '../domain/agent';
import { AgentEntity } from './entities';

function toDomain(entity: AgentEntity): Agent {
  return { ...entity, adapter: entity.adapter as AdapterId, config: entity.config as AgentConfig };
}

@Injectable()
export class TypeormAgentRepository implements AgentRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(agent: Agent): Promise<void> {
    await this.ds.getRepository(AgentEntity).insert({ ...agent });
  }

  async save(agent: Agent): Promise<void> {
    await this.ds.getRepository(AgentEntity).update({ id: agent.id }, { ...agent });
  }

  async findById(id: string): Promise<Agent | null> {
    const entity = await this.ds.getRepository(AgentEntity).findOneBy({ id });
    return entity ? toDomain(entity) : null;
  }

  async findByOwnerAndName(ownerId: string, name: string): Promise<Agent | null> {
    const entity = await this.ds.getRepository(AgentEntity).findOneBy({ ownerId, name });
    return entity ? toDomain(entity) : null;
  }

  async listByOwner(ownerId: string): Promise<Agent[]> {
    const rows = await this.ds
      .getRepository(AgentEntity)
      .find({ where: { ownerId }, order: { name: 'ASC' } });
    return rows.map(toDomain);
  }

  async delete(id: string): Promise<void> {
    await this.ds.getRepository(AgentEntity).delete({ id });
  }
}
