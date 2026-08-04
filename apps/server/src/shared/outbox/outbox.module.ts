import { Global, Module } from '@nestjs/common';
import { UnitOfWork } from '../../database/unit-of-work';
import { DomainEventBus } from '../events/domain-event-bus';
import { OutboxWriter } from './outbox.writer';

@Global()
@Module({
  providers: [UnitOfWork, OutboxWriter, DomainEventBus],
  exports: [UnitOfWork, OutboxWriter, DomainEventBus],
})
export class OutboxModule {}
