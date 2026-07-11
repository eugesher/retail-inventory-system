export * from './stock-cache.port';
export * from './stock-events.publisher.port';
export * from './stock.repository.port';
export * from './reservation.repository.port';
export * from './reservation-sweep.tokens';
export * from './reservation-ttl.token';
export * from './occ-retry-attempts.token';
export * from './stock-movement.repository.port';
// The transaction seam is shared, not module-local (ADR-043). Re-exported here so the
// module's ports stay one barrel: a use case still writes `from '../ports'`.
export {
  ITransactionPort,
  ITransactionScope,
  TRANSACTION_PORT,
} from '@retail-inventory-system/ddd';
