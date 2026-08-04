import type { ObjectLiteral } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';

/**
 * TypeORM's QueryDeepPartialEntity cannot express recursive Json payload
 * types. Repositories construct fully-shaped rows, so this cast at the
 * persistence boundary is sound.
 */
export function toRow<T extends ObjectLiteral>(value: object): QueryDeepPartialEntity<T> {
  return value as unknown as QueryDeepPartialEntity<T>;
}

export function toRows<T extends ObjectLiteral>(values: object[]): QueryDeepPartialEntity<T>[] {
  return values as unknown as QueryDeepPartialEntity<T>[];
}
