import { AddressEntity } from './address.entity';
import { FulfillmentEntity } from './fulfillment.entity';
import { FulfillmentLineEntity } from './fulfillment-line.entity';
import { OrderEntity } from './order.entity';
import { OrderLineEntity } from './order-line.entity';
import { PaymentEntity } from './payment.entity';
import { RefundEntity } from './refund.entity';

// A concrete entity array (spreadable) so retail `app.module.ts` can merge it with
// `cartEntities` into the one `DatabaseModule.forRoot([...])` connection. Adding the
// `Fulfillment{,Line}Entity` / `RefundEntity` rows here is what registers the
// `fulfillment` / `fulfillment_line` / `refund` tables at the root connection —
// `app.module.ts` spreads `orderEntities`, so no edit there is needed.
export const orderEntities = [
  OrderEntity,
  OrderLineEntity,
  AddressEntity,
  PaymentEntity,
  FulfillmentEntity,
  FulfillmentLineEntity,
  RefundEntity,
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
