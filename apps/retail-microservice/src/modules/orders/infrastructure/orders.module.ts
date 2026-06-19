import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientCatalogModule,
  MicroserviceClientInventoryModule,
  MicroserviceClientNotificationModule,
  MicroserviceClientRetailModule,
} from '@retail-inventory-system/messaging';

import {
  ADDRESS_REPOSITORY,
  FULFILLMENT_REPOSITORY,
  ORDER_CART_READER,
  ORDER_CATALOG_GATEWAY,
  ORDER_COMMIT_SALE_GATEWAY,
  ORDER_EVENTS_PUBLISHER,
  ORDER_INVENTORY_GATEWAY,
  ORDER_REPOSITORY,
  PAYMENT_GATEWAY,
  PAYMENT_REPOSITORY,
  REFUND_REPOSITORY,
  TRANSACTION_PORT,
} from '../application/ports';
import {
  AuthorizePaymentUseCase,
  CancelLineUseCase,
  CancelOrderUseCase,
  CapturePaymentUseCase,
  CreateFulfillmentUseCase,
  GetOrderUseCase,
  ListFulfillmentsUseCase,
  ListMyOrdersUseCase,
  MarkDeliveredUseCase,
  PlaceOrderUseCase,
  ShipFulfillmentUseCase,
} from '../application/use-cases';
import {
  OrderCatalogRabbitmqAdapter,
  OrderCommitSaleRabbitmqAdapter,
  OrderInventoryRabbitmqAdapter,
  OrderRabbitmqPublisher,
} from './messaging';
import {
  AddressEntity,
  AddressTypeormRepository,
  CartReaderTypeormAdapter,
  FulfillmentEntity,
  FulfillmentLineEntity,
  FulfillmentTypeormRepository,
  OrderEntity,
  OrderLineEntity,
  OrderTypeormRepository,
  PaymentEntity,
  PaymentTypeormRepository,
  RefundEntity,
  RefundTypeormRepository,
  TypeormTransactionAdapter,
} from './persistence';
import { FakePaymentGatewayAdapter } from './payment-gateway';
import { OrdersController, OrdersRpcExceptionFilter } from '../presentation';

// The orders bounded-context module: the `Order` / `Address` / `Payment` /
// `Fulfillment` repositories, the `PAYMENT_GATEWAY` seam (default
// `FakePaymentGatewayAdapter`, ADR-028 §4), the transactional unit-of-work
// (`TRANSACTION_PORT`), the outbound seams (catalog snapshot reads, the inventory
// allocate/cancel + commit-sale seams, and the order/payment/fulfillment event emits),
// the Place Order + Authorize Payment + Capture Payment + Get Order + List My Orders +
// Create Fulfillment + List Fulfillments + Ship Fulfillment + Mark Delivered +
// Cancel Order + Cancel Line use cases, and the `retail.cart.place` /
// `retail.order.get` / `retail.order.list` / `retail.payment.capture` /
// `retail.fulfillment.create` / `retail.fulfillment.list` / `retail.fulfillment.ship` /
// `retail.fulfillment.deliver` / `retail.order.cancel` / `retail.order.cancel-line` RPC
// controller.
//
// Four messaging clients are imported: `MicroserviceClientCatalogModule` so Place
// Order can snapshot from `catalog.variant.get` / `catalog.price.select` on
// `catalog_queue`; `MicroserviceClientInventoryModule` so Place Order can allocate
// (and compensate-cancel) the cart's stock holds via `inventory.reservation.allocate`
// / `inventory.allocation.cancel` and Ship Fulfillment can decrement physical stock
// via `inventory.stock.commit-sale` on `inventory_queue` (ADR-030 §4 / ADR-031);
// `MicroserviceClientNotificationModule` so `retail.order.placed` lands on
// `notification_events` (the consumer's queue); and `MicroserviceClientRetailModule`
// so the reserved `retail.payment.authorized` event lands on the service's own
// `retail_queue`. `useExisting` shares each adapter
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
    DatabaseModule.forFeature([
      OrderEntity,
      OrderLineEntity,
      AddressEntity,
      PaymentEntity,
      FulfillmentEntity,
      FulfillmentLineEntity,
      RefundEntity,
    ]),
    MicroserviceClientCatalogModule,
    MicroserviceClientInventoryModule,
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
    FulfillmentTypeormRepository,
    { provide: FULFILLMENT_REPOSITORY, useExisting: FulfillmentTypeormRepository },
    RefundTypeormRepository,
    { provide: REFUND_REPOSITORY, useExisting: RefundTypeormRepository },

    TypeormTransactionAdapter,
    { provide: TRANSACTION_PORT, useExisting: TypeormTransactionAdapter },
    CartReaderTypeormAdapter,
    { provide: ORDER_CART_READER, useExisting: CartReaderTypeormAdapter },

    OrderCatalogRabbitmqAdapter,
    { provide: ORDER_CATALOG_GATEWAY, useExisting: OrderCatalogRabbitmqAdapter },
    OrderInventoryRabbitmqAdapter,
    { provide: ORDER_INVENTORY_GATEWAY, useExisting: OrderInventoryRabbitmqAdapter },
    OrderCommitSaleRabbitmqAdapter,
    { provide: ORDER_COMMIT_SALE_GATEWAY, useExisting: OrderCommitSaleRabbitmqAdapter },
    OrderRabbitmqPublisher,
    { provide: ORDER_EVENTS_PUBLISHER, useExisting: OrderRabbitmqPublisher },

    AuthorizePaymentUseCase,
    PlaceOrderUseCase,
    GetOrderUseCase,
    ListMyOrdersUseCase,
    CapturePaymentUseCase,
    CreateFulfillmentUseCase,
    ListFulfillmentsUseCase,
    ShipFulfillmentUseCase,
    MarkDeliveredUseCase,
    CancelOrderUseCase,
    CancelLineUseCase,

    { provide: APP_FILTER, useClass: OrdersRpcExceptionFilter },
  ],
  exports: [ORDER_REPOSITORY, ADDRESS_REPOSITORY, PAYMENT_REPOSITORY, PAYMENT_GATEWAY],
})
export class OrdersModule {}
