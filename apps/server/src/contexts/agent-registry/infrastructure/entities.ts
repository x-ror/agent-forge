import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('agents')
export class AgentEntity {
  @PrimaryColumn('uuid') id: string;
  @Column('uuid') ownerId: string;
  @Column('text') name: string;
  @Column('text') adapter: string;
  @Column('jsonb') config: unknown;
  @Column('timestamptz') createdAt: Date;
}
