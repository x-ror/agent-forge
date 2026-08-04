import { Inject, Injectable } from '@nestjs/common';
import { LessThan, type DataSource } from 'typeorm';
import { DATA_SOURCE } from '../../../database/database.module';
import type { PersonalAccessTokenRepository, SessionRepository, UserRepository } from '../domain/repositories';
import type { PersonalAccessToken, Session, User } from '../domain/user';
import { PersonalAccessTokenEntity, SessionEntity, UserEntity } from './entities';

@Injectable()
export class TypeormUserRepository implements UserRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(user: User): Promise<void> {
    await this.ds.getRepository(UserEntity).insert({ ...user });
  }

  async findById(id: string): Promise<User | null> {
    return this.ds.getRepository(UserEntity).findOneBy({ id });
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.ds.getRepository(UserEntity).findOneBy({ email });
  }

  async count(): Promise<number> {
    return this.ds.getRepository(UserEntity).count();
  }
}

@Injectable()
export class TypeormSessionRepository implements SessionRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(session: Session): Promise<void> {
    await this.ds.getRepository(SessionEntity).insert({ ...session });
  }

  async findByTokenHash(tokenHash: string): Promise<Session | null> {
    return this.ds.getRepository(SessionEntity).findOneBy({ tokenHash });
  }

  async touch(id: string, lastSeenAt: Date): Promise<void> {
    await this.ds.getRepository(SessionEntity).update({ id }, { lastSeenAt });
  }

  async deleteById(id: string): Promise<void> {
    await this.ds.getRepository(SessionEntity).delete({ id });
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.ds.getRepository(SessionEntity).delete({ expiresAt: LessThan(now) });
    return result.affected ?? 0;
  }
}

@Injectable()
export class TypeormPersonalAccessTokenRepository implements PersonalAccessTokenRepository {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  async insert(pat: PersonalAccessToken): Promise<void> {
    await this.ds.getRepository(PersonalAccessTokenEntity).insert({ ...pat });
  }

  async findByTokenHash(tokenHash: string): Promise<PersonalAccessToken | null> {
    return this.ds.getRepository(PersonalAccessTokenEntity).findOneBy({ tokenHash });
  }

  async listByUser(userId: string): Promise<PersonalAccessToken[]> {
    return this.ds.getRepository(PersonalAccessTokenEntity).find({ where: { userId }, order: { createdAt: 'DESC' } });
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.ds.getRepository(PersonalAccessTokenEntity).update({ id }, { revokedAt: at });
  }

  async markUsed(id: string, at: Date): Promise<void> {
    await this.ds.getRepository(PersonalAccessTokenEntity).update({ id }, { lastUsedAt: at });
  }
}
