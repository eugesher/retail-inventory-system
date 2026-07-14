import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';

import { AUDIT_LOG_PUBLISHER } from '@retail-inventory-system/contracts';
import { DatabaseModule, TypeormTransactionAdapter } from '@retail-inventory-system/database';
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
} from './application/ports';
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
} from './application/use-cases';
import { OrderCancelledConsumer } from './infrastructure/consumers';
import {
  IdempotencyPurgeScheduler,
  IdempotencyStoreTypeormRepository,
} from './infrastructure/idempotency';
import {
  OrderCatalogRabbitmqAdapter,
  OrderCommitSaleRabbitmqAdapter,
  OrderInventoryRabbitmqAdapter,
  OrderRabbitmqPublisher,
} from './infrastructure/messaging';
import {
  AddressTypeormRepository,
  CartReaderTypeormAdapter,
  CustomerContactReaderTypeormAdapter,
  FulfillmentTypeormRepository,
  OrderTypeormRepository,
  PaymentTypeormRepository,
  RefundTypeormRepository,
  orderEntities,
} from './infrastructure/persistence';
import { FakePaymentGatewayAdapter } from './infrastructure/payment-gateway';
import { AuditLogRabbitmqPublisher } from './infrastructure/audit';
import { OrdersController, OrderRpcExceptionFilter } from './presentation';

// The orders bounded-context module — five sibling aggregates (`Order`, `Address`, `Payment`,
// `Fulfillment`, `Refund`) behind one composition root. The `providers` array below is the
// inventory of what it wires; the routing keys its controller serves are in README §2. What
// follows is only what neither of those will tell you.
//
// **Why each messaging client is here** (the surprising ones first):
//
// - `MicroserviceClientRetailModule` — orders publishes back onto its **own** `retail_queue`.
//   That is not a curiosity: `retail.order.cancelled` rides it into `OrderCancelledConsumer`
//   (registered as a controller below), which is how a cancelled order auto-refunds. The other
//   keys it carries bind no consumer at all — reserved surfaces, still caught by the firehose.
// - `MicroserviceClientNotificationModule` — the producer targets the **consumer's** queue
//   (ADR-008/020), so an event the notification service consumes is emitted onto
//   `notification_events`, never onto retail's own. `retail.order.cancelled` goes to **both**.
// - `MicroserviceClientCatalogModule` — Place Order's snapshot reads (`catalog.variant.get` /
//   `catalog.price.select`).
// - `MicroserviceClientInventoryModule` — Place Order allocates and compensate-cancels the
//   cart's holds; Ship decrements physical stock via `inventory.stock.commit-sale`
//   (ADR-030 §4 / ADR-031).
// - `MicroserviceClientRisEventsModule` — the `ris.events` topic exchange, so
//   `AuditLogRabbitmqPublisher` can emit `audit.staff.action` (ADR-035).
//
// `useExisting` shares each adapter instance between code that injects the concrete class and
// use cases that depend on the port symbol (the `cart.module.ts` / `stock.module.ts` pattern).
// `OrderRpcExceptionFilter` goes on via `APP_FILTER`, so every order `@MessagePattern` maps its
// `OrderDomainException` onto the wire status the gateway resolves.
//
// The orders module reaches the **cart** tables only through `CartReaderTypeormAdapter`
// (raw parameterized SQL — the cart is a sibling module behind the boundaries-lint
// isolation line, ADR-017); it never imports the cart module.
@Module({
  imports: [
    DatabaseModule.forFeature(orderEntities),
    MicroserviceClientCatalogModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientNotificationModule,
    MicroserviceClientRetailModule,
    // The producer-side client for the `ris.events` topic exchange — the real
    // `AuditLogRabbitmqPublisher` injects its `RIS_EVENTS_PUBLISHER` `ClientProxy` to
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

    // The request-level idempotency store (ADR-036) — the stored-response dedup substrate for
    // the money-/stock-moving writes. A direct-implement repository (the append-only
    // `domain_event` precedent), bound to `IDEMPOTENCY_STORE`. **The four callers do not use it
    // the same way:** Place, Capture and Ship take the `find → run → save` path, which checks
    // and then acts; only Issue Refund takes `reserve → run → finalize`, which claims the key
    // atomically *before* any side effect. `idempotency-store.port.ts` explains why the refund
    // is the one that had to.
    IdempotencyStoreTypeormRepository,
    { provide: IDEMPOTENCY_STORE, useExisting: IdempotencyStoreTypeormRepository },
    // The TTL purge that keeps the store bounded to its retention window: the use case owns the
    // delete, the scheduler owns the timer (ADR-036).
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
    AuditLogRabbitmqPublisher,
    { provide: AUDIT_LOG_PUBLISHER, useExisting: AuditLogRabbitmqPublisher },

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

    { provide: APP_FILTER, useClass: OrderRpcExceptionFilter },
  ],
  exports: [ORDER_REPOSITORY, ADDRESS_REPOSITORY, PAYMENT_REPOSITORY, PAYMENT_GATEWAY],
})
export class OrdersModule {}
