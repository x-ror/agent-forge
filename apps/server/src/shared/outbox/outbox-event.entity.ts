import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('outbox_events')
export class OutboxEventEntity {
  /** GENERATED ALWAYS AS IDENTITY — never set on insert; pg returns bigint as string. */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column('text') aggregateType: string;
  @Column('uuid') aggregateId: string;
  @Column('text') eventType: string;
  @Column('jsonb') payload: unknown;
  @Column('timestamptz') createdAt: Date;
  @Column('timestamptz', { nullable: true }) dispatchedAt: Date | null;
}
