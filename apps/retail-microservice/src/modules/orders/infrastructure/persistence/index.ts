import { AddressEntity } from './address.entity';
import { OrderEntity } from './order.entity';
import { OrderLineEntity } from './order-line.entity';
import { PaymentEntity } from './payment.entity';

// A concrete entity array (spreadable) so retail `app.module.ts` can merge it with
// `cartEntities` into the one `DatabaseModule.forRoot([...])` connection. Adding
// `PaymentEntity` here is what registers the `payment` table at the root connection —
// `app.module.ts` spreads `orderEntities`, so no edit there is needed.
export const orderEntities = [OrderEntity, OrderLineEntity, AddressEntity, PaymentEntity];

export { AddressEntity, OrderEntity, OrderLineEntity, PaymentEntity };
export * from './address.mapper';
export * from './address-typeorm.repository';
export * from './cart-reader-typeorm.adapter';
export * from './order.mapper';
export * from './order-line.mapper';
export * from './order-typeorm.repository';
export * from './payment.mapper';
export * from './payment-typeorm.repository';
export * from './typeorm-transaction.adapter';
