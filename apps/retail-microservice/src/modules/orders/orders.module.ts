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
  CAPTURE_CLAIM_STALE_MINUTES,
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
  ReportStaleCaptureClaimsUseCase,
  ShipFulfillmentUseCase,
} from './application/use-cases';
import { OrderCancelledConsumer } from './infrastructure/consumers';
import {
  IdempotencyPurgeScheduler,
  IdempotencyStoreTypeormRepository,
} from './infrastructure/idempotency';
import { StaleCaptureClaimScheduler } from './infrastructure/scheduling';
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

@Module({
  imports: [
    DatabaseModule.forFeature(orderEntities),
    MicroserviceClientCatalogModule,
    MicroserviceClientInventoryModule,
    MicroserviceClientNotificationModule,
    MicroserviceClientRetailModule,
    MicroserviceClientRisEventsModule,
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

    IdempotencyStoreTypeormRepository,
    { provide: IDEMPOTENCY_STORE, useExisting: IdempotencyStoreTypeormRepository },
    PurgeExpiredIdempotencyKeysUseCase,
    IdempotencyPurgeScheduler,

    ReportStaleCaptureClaimsUseCase,
    StaleCaptureClaimScheduler,
    {
      provide: CAPTURE_CLAIM_STALE_MINUTES,
      useFactory: (config: ConfigService): number =>
        config.get<number>('CAPTURE_CLAIM_STALE_MINUTES') ?? 15,
      inject: [ConfigService],
    },
    {
      provide: IDEMPOTENCY_KEY_TTL_HOURS,
      useFactory: (config: ConfigService): number =>
        config.get<number>('IDEMPOTENCY_KEY_TTL_HOURS') ?? 24,
      inject: [ConfigService],
    },
    {
      provide: OCC_RETRY_ATTEMPTS,
      useFactory: (config: ConfigService): number => config.get<number>('OCC_RETRY_ATTEMPTS') ?? 5,
      inject: [ConfigService],
    },

    TypeormTransactionAdapter,
    { provide: TRANSACTION_PORT, useExisting: TypeormTransactionAdapter },
    CartReaderTypeormAdapter,
    { provide: ORDER_CART_READER, useExisting: CartReaderTypeormAdapter },
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
