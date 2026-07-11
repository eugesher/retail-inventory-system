import { IdempotencyKeyEntity } from '../idempotency';
import { AddressEntity } from './address.entity';
import { FulfillmentEntity } from './fulfillment.entity';
import { FulfillmentLineEntity } from './fulfillment-line.entity';
import { OrderEntity } from './order.entity';
import { OrderLineEntity } from './order-line.entity';
import { PaymentEntity } from './payment.entity';
import { RefundEntity } from './refund.entity';

// A concrete entity array — UNANNOTATED on purpose (see the note on `DatabaseModule.forRoot`)
// — so it is spreadable and retail `app.module.ts` can merge it with
// `cartEntities` into the one `DatabaseModule.forRoot([...])` connection. Adding a row
// here is what registers its table at the root connection — `app.module.ts` spreads
// `orderEntities`, so no edit there is needed. The `IdempotencyKeyEntity` (the
// retail-owned request-level idempotency store, ADR-036) lives under
// `infrastructure/idempotency/` but registers through this array like the rest.
export const orderEntities = [
  OrderEntity,
  OrderLineEntity,
  AddressEntity,
  PaymentEntity,
  FulfillmentEntity,
  FulfillmentLineEntity,
  RefundEntity,
  IdempotencyKeyEntity,
];

export {
  AddressEntity,
  FulfillmentEntity,
  FulfillmentLineEntity,
  OrderEntity,
  OrderLineEntity,
  PaymentEntity,
  RefundEntity,
};
export * from './address.mapper';
export * from './address-typeorm.repository';
export * from './cart-reader-typeorm.adapter';
export * from './customer-contact-reader.typeorm.adapter';
export * from './fulfillment.mapper';
export * from './fulfillment-line.mapper';
export * from './fulfillment-typeorm.repository';
export * from './order.mapper';
export * from './order-line.mapper';
export * from './order-typeorm.repository';
export * from './payment.mapper';
export * from './payment-typeorm.repository';
export * from './refund.mapper';
export * from './refund-typeorm.repository';
export * from './typeorm-transaction.adapter';
