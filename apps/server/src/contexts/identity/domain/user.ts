export interface User {
  id: string;
  email: string;
  passwordHash: string | null;
  createdAt: Date;
}

export interface Session {
  id: string;
  userId: string;
  /** SHA-256 of the opaque cookie token — the raw token is never stored. */
  tokenHash: string;
  createdAt: Date;
  expiresAt: Date;
  lastSeenAt: Date | null;
}

export interface PersonalAccessToken {
  id: string;
  userId: string;
  name: string;
  /** SHA-256 of the raw token — shown to the user exactly once at creation. */
  tokenHash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export function isSessionExpired(session: Session, now = new Date()): boolean {
  return session.expiresAt.getTime() <= now.getTime();
}

export function isPatActive(pat: PersonalAccessToken): boolean {
  return pat.revokedAt === null;
}
