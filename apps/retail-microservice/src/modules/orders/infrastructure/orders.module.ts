import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { AUDIT_LOG_PUBLISHER } from '@retail-inventory-system/contracts';
import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientCatalogModule,
  MicroserviceClientInventoryModule,
  MicroserviceClientNotificationModule,
  MicroserviceClientRetailModule,
  MicroserviceClientRisEventsModule,
} from '@retail-inventory-system/messaging';

import {
  ADDRESS_REPOSITORY,
  FULFILLMENT_REPOSITORY,
  IDEMPOTENCY_KEY_TTL_HOURS,
  IDEMPOTENCY_STORE,
  OCC_RETRY_ATTEMPTS,
  ORDER_CART_READER,
  ORDER_CUSTOMER_CONTACT_READER,
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
  IssueRefundUseCase,
  ListFulfillmentsUseCase,
  ListMyOrdersUseCase,
  ListRefundsForOrderUseCase,
  MarkDeliveredUseCase,
  PlaceOrderUseCase,
  PurgeExpiredIdempotencyKeysUseCase,
  ShipFulfillmentUseCase,
} from '../application/use-cases';
import { OrderCancelledConsumer } from './consumers';
import {
  IdempotencyKeyEntity,
  IdempotencyPurgeScheduler,
  IdempotencyStoreTypeormRepository,
} from './idempotency';
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
  CustomerContactReaderTypeormAdapter,
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
import { RmqAuditLogPublisher } from './audit';
import { OrdersController, OrdersRpcExceptionFilter } from '../presentation';

// The orders bounded-context module: the `Order` / `Address` / `Payment` /
// `Fulfillment` / `Refund` repositories, the `PAYMENT_GATEWAY` seam (default
// `FakePaymentGatewayAdapter`, ADR-028 §4), the `AUDIT_LOG_PUBLISHER` seam (the real
// `RmqAuditLogPublisher` onto `ris.events`, the always-audit money-movement rule,
// ADR-032/035), the
// transactional unit-of-work (`TRANSACTION_PORT`), the outbound seams (catalog snapshot
// reads, the inventory allocate/cancel + commit-sale seams, and the
// order/payment/fulfillment/refund event emits), the Place Order + Authorize Payment +
// Capture Payment + Get Order + List My Orders + Create Fulfillment + List Fulfillments +
// Ship Fulfillment + Mark Delivered + Cancel Order + Cancel Line + Issue Refund +
// List Refunds use cases, and the `retail.cart.place` / `retail.order.get` /
// `retail.order.list` / `retail.payment.capture` / `retail.fulfillment.create` /
// `retail.fulfillment.list` / `retail.fulfillment.ship` / `retail.fulfillment.deliver` /
// `retail.order.cancel` / `retail.order.cancel-line` / `retail.refund.issue` /
// `retail.refund.list` RPC controller. It also registers the `OrderCancelledConsumer`
// (`@EventPattern retail.order.cancelled`) — the auto-refund-from-cancel subscriber that
// listens to retail's **own** cancel event on `retail_queue` and, when
// `paymentFlaggedForRefund=true`, issues a full refund inline via `IssueRefundUseCase`
// (ADR-032).
//
// Five messaging clients are imported: `MicroserviceClientCatalogModule` so Place
// Order can snapshot from `catalog.variant.get` / `catalog.price.select` on
// `catalog_queue`; `MicroserviceClientInventoryModule` so Place Order can allocate
// (and compensate-cancel) the cart's stock holds via `inventory.reservation.allocate`
// / `inventory.allocation.cancel` and Ship Fulfillment can decrement physical stock
// via `inventory.stock.commit-sale` on `inventory_queue` (ADR-030 §4 / ADR-031);
// `MicroserviceClientNotificationModule` so `retail.order.placed` lands on
// `notification_events` (the consumer's queue); `MicroserviceClientRetailModule`
// so the reserved `retail.payment.authorized` event lands on the service's own
// `retail_queue`; and `MicroserviceClientRisEventsModule` so `RmqAuditLogPublisher`
// can emit `audit.staff.action` onto the `ris.events` topic exchange (ADR-035).
// `useExisting` shares each adapter
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
      IdempotencyKeyEntity,
    ]),
    MicroserviceClientCatalogModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientNotificationModule,
    MicroserviceClientRetailModule,
    // The producer-side client for the `ris.events` topic exchange — the real
    // `RmqAuditLogPublisher` injects its `RIS_EVENTS_PUBLISHER` `ClientProxy` to
    // emit `audit.staff.action` for the always-audit refund money movements (ADR-035).
    MicroserviceClientRisEventsModule,
    // Discovers the `@Cron` on `IdempotencyPurgeScheduler` so the TTL sweep fires on its
    // timer (ADR-036). Registered here — the only retail module with a scheduled job —
    // the notification `NotificationsModule` precedent (a global module, wired once in the
    // module that owns the scheduler, not the app root).
    ScheduleModule.forRoot(),
  ],
  controllers: [OrdersController, OrderCancelledConsumer],
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

    // The request-level idempotency store (ADR-036) — the stored-response dedup
    // substrate for the money-/stock-moving HTTP writes. Direct-implement repository
    // (the append-only `domain_event` precedent), bound to the `IDEMPOTENCY_STORE`
    // port. `PlaceOrderUseCase` consumes it (find → replay/422 → run → save); the
    // remaining money moves (capture / ship / refund) adopt the same pattern.
    IdempotencyStoreTypeormRepository,
    { provide: IDEMPOTENCY_STORE, useExisting: IdempotencyStoreTypeormRepository },
    // The TTL purge: a use case that deletes rows past `expires_at` (via
    // `IDEMPOTENCY_STORE.deleteExpired`) and the `@nestjs/schedule` driver that fires it
    // every ten minutes, keeping the store bounded to its retention window (ADR-036).
    PurgeExpiredIdempotencyKeysUseCase,
    IdempotencyPurgeScheduler,
    // The retention horizon (hours) the store reads to compute `expires_at`, resolved
    // from `IDEMPOTENCY_KEY_TTL_HOURS` (Joi default 24) so the adapter injects a plain
    // number rather than reading env (ADR-017; the inventory `RESERVATION_TTL_MINUTES`
    // / `OCC_RETRY_ATTEMPTS` precedent).
    {
      provide: IDEMPOTENCY_KEY_TTL_HOURS,
      useFactory: (config: ConfigService): number =>
        config.get<number>('IDEMPOTENCY_KEY_TTL_HOURS') ?? 24,
      inject: [ConfigService],
    },
    // The bounded optimistic-concurrency retry budget (ADR-036), resolved from
    // `OCC_RETRY_ATTEMPTS` (Joi default 5) so the order status use cases inject a
    // plain number rather than reading env (ADR-017; the inventory / cart
    // `OCC_RETRY_ATTEMPTS` precedent). It caps `runWithOrderWriteRetry`'s retries on a
    // lost version CAS before the write surfaces a `409 VERSION_MISMATCH`.
    {
      provide: OCC_RETRY_ATTEMPTS,
      useFactory: (config: ConfigService): number => config.get<number>('OCC_RETRY_ATTEMPTS') ?? 5,
      inject: [ConfigService],
    },

    TypeormTransactionAdapter,
    { provide: TRANSACTION_PORT, useExisting: TypeormTransactionAdapter },
    CartReaderTypeormAdapter,
    { provide: ORDER_CART_READER, useExisting: CartReaderTypeormAdapter },
    // The raw-SQL read of the gateway-owned `customer.email` the order events carry, so the
    // notification consumer has a recipient without a per-delivery RPC (ADR-033). It never
    // imports the gateway `CustomerEntity` — the `CartReaderTypeormAdapter` precedent (ADR-017).
    CustomerContactReaderTypeormAdapter,
    { provide: ORDER_CUSTOMER_CONTACT_READER, useExisting: CustomerContactReaderTypeormAdapter },

    OrderCatalogRabbitmqAdapter,
    { provide: ORDER_CATALOG_GATEWAY, useExisting: OrderCatalogRabbitmqAdapter },
    OrderInventoryRabbitmqAdapter,
    { provide: ORDER_INVENTORY_GATEWAY, useExisting: OrderInventoryRabbitmqAdapter },
    OrderCommitSaleRabbitmqAdapter,
    { provide: ORDER_COMMIT_SALE_GATEWAY, useExisting: OrderCommitSaleRabbitmqAdapter },
    OrderRabbitmqPublisher,
    { provide: ORDER_EVENTS_PUBLISHER, useExisting: OrderRabbitmqPublisher },
    // The always-audit seam for refund money movements (ADR-032/035): the real RMQ
    // adapter publishes `audit.staff.action` onto the `ris.events` topic exchange.
    RmqAuditLogPublisher,
    { provide: AUDIT_LOG_PUBLISHER, useExisting: RmqAuditLogPublisher },

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
    IssueRefundUseCase,
    ListRefundsForOrderUseCase,

    { provide: APP_FILTER, useClass: OrdersRpcExceptionFilter },
  ],
  exports: [ORDER_REPOSITORY, ADDRESS_REPOSITORY, PAYMENT_REPOSITORY, PAYMENT_GATEWAY],
})
export class OrdersModule {}
