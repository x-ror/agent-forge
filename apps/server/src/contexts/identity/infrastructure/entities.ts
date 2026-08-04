import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('users')
export class UserEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('citext') email: string;
  @Column('text', { nullable: true }) passwordHash: string | null;
  @Column('timestamptz') createdAt: Date;
}

@Entity('sessions')
export class SessionEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') userId: string;
  @Column('text') tokenHash: string;
  @Column('timestamptz') createdAt: Date;
  @Column('timestamptz') expiresAt: Date;
  @Column('timestamptz', { nullable: true }) lastSeenAt: Date | null;
}

@Entity('personal_access_tokens')
export class PersonalAccessTokenEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') userId: string;
  @Column('text') name: string;
  @Column('text') tokenHash: string;
  @Column('timestamptz') createdAt: Date;
  @Column('timestamptz', { nullable: true }) lastUsedAt: Date | null;
  @Column('timestamptz', { nullable: true }) revokedAt: Date | null;
}
