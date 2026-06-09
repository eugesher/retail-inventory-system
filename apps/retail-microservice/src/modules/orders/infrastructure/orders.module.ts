import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import { ADDRESS_REPOSITORY, ORDER_REPOSITORY } from '../application/ports';
import {
  AddressEntity,
  AddressTypeormRepository,
  OrderEntity,
  OrderLineEntity,
  OrderTypeormRepository,
} from './persistence';

// Foundation wiring only: the `Order` aggregate's repository over its `order` /
// `order_line` tables and the polymorphic `Address` aggregate's repository over its
// `address` table. No publisher, use cases, controller, or `PAYMENT_GATEWAY` yet —
// the order operations + their gateway and the payment aggregate land in later
// capabilities, so the retail microservice boots with the `orders` module
// registered but no `@MessagePattern` / `@EventPattern` handlers.
//
// `useExisting` shares the single adapter instance with code that injects the
// concrete class directly, while consumers depend on the `ORDER_REPOSITORY` /
// `ADDRESS_REPOSITORY` port symbols (mirrors `cart.module.ts` / `stock.module.ts`).
// `DatabaseModule.forFeature` registers the three entities' repositories for
// `@InjectRepository`.
@Module({
  imports: [DatabaseModule.forFeature([OrderEntity, OrderLineEntity, AddressEntity])],
  providers: [
    OrderTypeormRepository,
    { provide: ORDER_REPOSITORY, useExisting: OrderTypeormRepository },
    AddressTypeormRepository,
    { provide: ADDRESS_REPOSITORY, useExisting: AddressTypeormRepository },
  ],
  exports: [ORDER_REPOSITORY, ADDRESS_REPOSITORY],
})
export class OrdersModule {}
