import type { PersonalAccessToken, Session, User } from './user';

export interface UserRepository {
  insert(user: User): Promise<void>;
  findById(id: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  count(): Promise<number>;
}

export interface SessionRepository {
  insert(session: Session): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  touch(id: string, lastSeenAt: Date): Promise<void>;
  deleteById(id: string): Promise<void>;
  deleteExpired(now: Date): Promise<number>;
}

export interface PersonalAccessTokenRepository {
  insert(pat: PersonalAccessToken): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<PersonalAccessToken | null>;
  listByUser(userId: string): Promise<PersonalAccessToken[]>;
  revoke(id: string, at: Date): Promise<void>;
  markUsed(id: string, at: Date): Promise<void>;
}

export const USER_REPOSITORY = Symbol('UserRepository');
export const SESSION_REPOSITORY = Symbol('SessionRepository');
export const PAT_REPOSITORY = Symbol('PersonalAccessTokenRepository');
