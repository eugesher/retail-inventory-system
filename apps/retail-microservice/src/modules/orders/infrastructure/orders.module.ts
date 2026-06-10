import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import {
  ADDRESS_REPOSITORY,
  ORDER_REPOSITORY,
  PAYMENT_GATEWAY,
  PAYMENT_REPOSITORY,
} from '../application/ports';
import {
  AddressEntity,
  AddressTypeormRepository,
  OrderEntity,
  OrderLineEntity,
  OrderTypeormRepository,
  PaymentEntity,
  PaymentTypeormRepository,
} from './persistence';
import { FakePaymentGatewayAdapter } from './payment-gateway';

// Foundation wiring: the `Order` aggregate's repository over its `order` /
// `order_line` tables, the polymorphic `Address` aggregate's repository over its
// `address` table, the `Payment` aggregate's repository over its `payment` table,
// and the `PAYMENT_GATEWAY` seam bound to its default `FakePaymentGatewayAdapter`
// (ADR-028 §4; the `NotifierPort` default-adapter pattern of ADR-011). No publisher,
// use cases, or controller yet — the order/payment operations + their gateway land
// in later capabilities, so the retail microservice boots with the `orders` module
// registered but no `@MessagePattern` / `@EventPattern` handlers.
//
// `useExisting` shares the single repository instance with code that injects the
// concrete class directly, while consumers depend on the `ORDER_REPOSITORY` /
// `ADDRESS_REPOSITORY` / `PAYMENT_REPOSITORY` port symbols (mirrors `cart.module.ts`
// / `stock.module.ts`). `PAYMENT_GATEWAY` binds via `useClass` — swapping in a real
// gateway later is a single change here. `DatabaseModule.forFeature` registers the
// four entities' repositories for `@InjectRepository`.
@Module({
  imports: [
    DatabaseModule.forFeature([OrderEntity, OrderLineEntity, AddressEntity, PaymentEntity]),
  ],
  providers: [
    OrderTypeormRepository,
    { provide: ORDER_REPOSITORY, useExisting: OrderTypeormRepository },
    AddressTypeormRepository,
    { provide: ADDRESS_REPOSITORY, useExisting: AddressTypeormRepository },
    PaymentTypeormRepository,
    { provide: PAYMENT_REPOSITORY, useExisting: PaymentTypeormRepository },
    { provide: PAYMENT_GATEWAY, useClass: FakePaymentGatewayAdapter },
  ],
  exports: [ORDER_REPOSITORY, ADDRESS_REPOSITORY, PAYMENT_REPOSITORY, PAYMENT_GATEWAY],
})
export class OrdersModule {}
