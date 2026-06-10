import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientCatalogModule,
  MicroserviceClientNotificationModule,
  MicroserviceClientRetailModule,
} from '@retail-inventory-system/messaging';

import {
  ADDRESS_REPOSITORY,
  ORDER_CART_READER,
  ORDER_CATALOG_GATEWAY,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
  PAYMENT_GATEWAY,
  PAYMENT_REPOSITORY,
  TRANSACTION_PORT,
} from '../application/ports';
import { AuthorizePaymentUseCase, PlaceOrderUseCase } from '../application/use-cases';
import { OrderCatalogRabbitmqAdapter, OrderRabbitmqPublisher } from './messaging';
import {
  AddressEntity,
  AddressTypeormRepository,
  CartReaderTypeormAdapter,
  OrderEntity,
  OrderLineEntity,
  OrderTypeormRepository,
  PaymentEntity,
  PaymentTypeormRepository,
  TypeormTransactionAdapter,
} from './persistence';
import { FakePaymentGatewayAdapter } from './payment-gateway';
import { OrdersController, OrdersRpcExceptionFilter } from '../presentation';

// The orders bounded-context module: the `Order` / `Address` / `Payment`
// repositories, the `PAYMENT_GATEWAY` seam (default `FakePaymentGatewayAdapter`,
// ADR-028 §4), the transactional unit-of-work (`TRANSACTION_PORT`), the two outbound
// seams (catalog snapshot reads + the order/payment event emits), the Place Order +
// Authorize Payment use cases, and the `retail.cart.place` RPC controller.
//
// Three messaging clients are imported: `MicroserviceClientCatalogModule` so Place
// Order can snapshot from `catalog.variant.get` / `catalog.price.select` on
// `catalog_queue`; `MicroserviceClientNotificationModule` so `retail.order.placed`
// lands on `notification_events` (the consumer's queue); and
// `MicroserviceClientRetailModule` so the reserved `retail.payment.authorized` event
// lands on the service's own `retail_queue`. `useExisting` shares each adapter
// instance with code that injects the concrete class while use cases depend on the
// port symbols (the `cart.module.ts` / `stock.module.ts` pattern). The
// `OrdersRpcExceptionFilter` is registered via `APP_FILTER` so every order
// `@MessagePattern` maps its `OrderDomainException` onto the wire status the gateway
// resolves.
//
// The orders module reaches the **cart** tables only through `CartReaderTypeormAdapter`
// (raw parameterized SQL — the cart is a sibling module behind the boundaries-lint
// isolation line, ADR-017); it never imports the cart module.
@Module({
  imports: [
    DatabaseModule.forFeature([OrderEntity, OrderLineEntity, AddressEntity, PaymentEntity]),
    MicroserviceClientCatalogModule,
    MicroserviceClientNotificationModule,
    MicroserviceClientRetailModule,
  ],
  controllers: [OrdersController],
  providers: [
    OrderTypeormRepository,
    { provide: ORDER_REPOSITORY, useExisting: OrderTypeormRepository },
    AddressTypeormRepository,
    { provide: ADDRESS_REPOSITORY, useExisting: AddressTypeormRepository },
    PaymentTypeormRepository,
    { provide: PAYMENT_REPOSITORY, useExisting: PaymentTypeormRepository },
    { provide: PAYMENT_GATEWAY, useClass: FakePaymentGatewayAdapter },

    TypeormTransactionAdapter,
    { provide: TRANSACTION_PORT, useExisting: TypeormTransactionAdapter },
    CartReaderTypeormAdapter,
    { provide: ORDER_CART_READER, useExisting: CartReaderTypeormAdapter },

    OrderCatalogRabbitmqAdapter,
    { provide: ORDER_CATALOG_GATEWAY, useExisting: OrderCatalogRabbitmqAdapter },
    OrderRabbitmqPublisher,
    { provide: ORDER_EVENTS_PUBLISHER, useExisting: OrderRabbitmqPublisher },

    AuthorizePaymentUseCase,
    PlaceOrderUseCase,

    { provide: APP_FILTER, useClass: OrdersRpcExceptionFilter },
  ],
  exports: [ORDER_REPOSITORY, ADDRESS_REPOSITORY, PAYMENT_REPOSITORY, PAYMENT_GATEWAY],
})
export class OrdersModule {}
