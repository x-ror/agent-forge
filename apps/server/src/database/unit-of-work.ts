import { Inject, Injectable } from '@nestjs/common';
import type { DataSource, EntityManager } from 'typeorm';
import { DATA_SOURCE } from './database.module';

/** One transaction for aggregate state + outbox rows — commit atomicity (§2.4). */
@Injectable()
export class UnitOfWork {
  constructor(@Inject(DATA_SOURCE) private readonly ds: DataSource) {}

  withTx<T>(fn: (em: EntityManager) => Promise<T>): Promise<T> {
    return this.ds.transaction(fn);
  }
}
