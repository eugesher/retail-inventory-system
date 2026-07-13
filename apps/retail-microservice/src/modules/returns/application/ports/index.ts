export * from './return-request.repository.port';
export * from './return-order-reader.port';
export * from './customer-contact-reader.port';
export * from './return-events.publisher.port';
export * from './inventory-restock.gateway.port';
// The OCC retry budget is shared, not module-local (ADR-043). Re-exported here so the
// module's ports stay one barrel: a use case still writes `from '../ports'`.
export { OCC_RETRY_ATTEMPTS } from '@retail-inventory-system/common';
export * from './return-window.token';
// The transaction seam is shared, not module-local (ADR-043). Re-exported here so the
// module's ports stay one barrel: a use case still writes `from '../ports'`.
export {
  ITransactionPort,
  ITransactionScope,
  TRANSACTION_PORT,
} from '@retail-inventory-system/ddd';
