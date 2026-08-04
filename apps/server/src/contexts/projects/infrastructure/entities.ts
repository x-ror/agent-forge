import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('projects')
export class ProjectEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') ownerId: string;
  @Column('text') name: string;
  @Column('text') repoUrl: string;
  @Column('text') defaultBranch: string;
  @Column('jsonb') settings: unknown;
  @Column('timestamptz') createdAt: Date;
}

@Entity('secrets')
export class SecretEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') projectId: string;
  @Column('text') key: string;
  @Column('bytea') ciphertext: Buffer;
  @Column('timestamptz') createdAt: Date;
}
