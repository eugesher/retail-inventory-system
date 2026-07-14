export * from './address.repository.port';
export * from './customer-contact-reader.port';
export * from './fulfillment.repository.port';
export * from './idempotency-key-ttl.token';
export * from './idempotency-store.port';
// The OCC retry budget is shared, not module-local (ADR-043). Re-exported here so the
// module's ports stay one barrel: a use case still writes `from '../ports'`.
export { OCC_RETRY_ATTEMPTS } from '@retail-inventory-system/common';
export * from './order.repository.port';
export * from './order-cart-reader.port';
export * from './order-catalog.gateway.port';
export * from './order-commit-sale.gateway.port';
export * from './order-inventory.gateway.port';
export * from './order-events.publisher.port';
export * from './payment-gateway.port';
export * from './capture-claim-stale.token';
export * from './payment.repository.port';
export * from './refund.repository.port';
// The transaction seam is shared, not module-local (ADR-043). Re-exported here so the
// module's ports stay one barrel: a use case still writes `from '../ports'`.
export {
  ITransactionPort,
  ITransactionScope,
  TRANSACTION_PORT,
} from '@retail-inventory-system/ddd';
