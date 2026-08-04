import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { uuidv7 } from '../../../shared/uuidv7';
import { PAT_REPOSITORY, SESSION_REPOSITORY, USER_REPOSITORY, type PersonalAccessTokenRepository, type SessionRepository, type UserRepository } from '../domain/repositories';
import { PASSWORD_HASHER, type PasswordHasher } from '../domain/password-hasher';
import { isSessionExpired, type PersonalAccessToken, type User } from '../domain/user';

export const SESSION_TTL_SECONDS = 30 * 24 * 3600;
const PAT_PREFIX = 'agf_pat_';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface AuthenticatedSession {
  user: User;
  sessionToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(SESSION_REPOSITORY) private readonly sessions: SessionRepository,
    @Inject(PAT_REPOSITORY) private readonly pats: PersonalAccessTokenRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async register(email: string, password: string): Promise<AuthenticatedSession> {
    const existing = await this.users.findByEmail(email);
    if (existing) throw new ConflictException('email already registered');
    const user: User = {
      id: uuidv7(),
      email,
      passwordHash: await this.hasher.hash(password),
      createdAt: new Date(),
    };
    await this.users.insert(user);
    return { user, sessionToken: await this.createSession(user.id) };
  }

  async login(email: string, password: string): Promise<AuthenticatedSession> {
    const user = await this.users.findByEmail(email);
    if (!user?.passwordHash || !(await this.hasher.verify(user.passwordHash, password))) {
      throw new UnauthorizedException('invalid credentials');
    }
    return { user, sessionToken: await this.createSession(user.id) };
  }

  async logout(sessionToken: string): Promise<void> {
    const session = await this.sessions.findByTokenHash(sha256Hex(sessionToken));
    if (session) await this.sessions.deleteById(session.id);
  }

  async validateSession(sessionToken: string): Promise<{ user: User; sessionId: string } | null> {
    const session = await this.sessions.findByTokenHash(sha256Hex(sessionToken));
    if (!session || isSessionExpired(session)) return null;
    const user = await this.users.findById(session.userId);
    if (!user) return null;
    const lastSeen = session.lastSeenAt?.getTime() ?? 0;
    if (Date.now() - lastSeen > 60_000) {
      await this.sessions.touch(session.id, new Date());
    }
    return { user, sessionId: session.id };
  }

  async validatePat(rawToken: string): Promise<User | null> {
    const pat = await this.pats.findByTokenHash(sha256Hex(rawToken));
    if (!pat || pat.revokedAt) return null;
    const user = await this.users.findById(pat.userId);
    if (!user) return null;
    await this.pats.markUsed(pat.id, new Date());
    return user;
  }

  async createPat(userId: string, name: string): Promise<{ pat: PersonalAccessToken; raw: string }> {
    const raw = PAT_PREFIX + randomBytes(24).toString('base64url');
    const pat: PersonalAccessToken = {
      id: uuidv7(),
      userId,
      name,
      tokenHash: sha256Hex(raw),
      createdAt: new Date(),
      lastUsedAt: null,
      revokedAt: null,
    };
    await this.pats.insert(pat);
    return { pat, raw };
  }

  async listPats(userId: string): Promise<PersonalAccessToken[]> {
    return this.pats.listByUser(userId);
  }

  async revokePat(userId: string, patId: string): Promise<void> {
    const list = await this.pats.listByUser(userId);
    if (list.some((p) => p.id === patId)) {
      await this.pats.revoke(patId, new Date());
    }
  }

  private async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.sessions.insert({
      id: uuidv7(),
      userId,
      tokenHash: sha256Hex(token),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + SESSION_TTL_SECONDS * 1000),
      lastSeenAt: new Date(),
    });
    return token;
  }
}
