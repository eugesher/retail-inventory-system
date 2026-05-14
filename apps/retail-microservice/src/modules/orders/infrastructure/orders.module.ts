import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';
import {
  MicroserviceClientInventoryModule,
  MicroserviceClientNotificationModule,
} from '@retail-inventory-system/messaging';

import {
  INVENTORY_CONFIRM_GATEWAY,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
} from '../application/ports';
import { ConfirmOrderUseCase, CreateOrderUseCase, GetOrderUseCase } from '../application/use-cases';
import { OrderController } from '../presentation/orders.controller';
import { OrderConfirmPipe, OrderCreatePipe } from '../presentation/pipes';
import { InventoryConfirmRabbitmqAdapter, OrderRabbitmqPublisher } from './messaging';
import {
  Customer,
  Order,
  OrderProduct,
  OrderProductStatus,
  OrderStatus,
  OrderTypeormRepository,
} from './persistence';

// Per-module wiring for the orders bounded context. Binds the three port
// symbols to their concrete adapters; `useExisting` shares the single
// adapter instance with code that injects the concrete class directly.
@Module({
  imports: [
    DatabaseModule.forFeature([Customer, Order, OrderProduct, OrderProductStatus, OrderStatus]),
    MicroserviceClientInventoryModule,
    MicroserviceClientNotificationModule,
  ],
  controllers: [OrderController],
  providers: [
    OrderTypeormRepository,
    { provide: ORDER_REPOSITORY, useExisting: OrderTypeormRepository },

    OrderRabbitmqPublisher,
    { provide: ORDER_EVENTS_PUBLISHER, useExisting: OrderRabbitmqPublisher },

    InventoryConfirmRabbitmqAdapter,
    { provide: INVENTORY_CONFIRM_GATEWAY, useExisting: InventoryConfirmRabbitmqAdapter },

    ConfirmOrderUseCase,
    CreateOrderUseCase,
    GetOrderUseCase,

    OrderConfirmPipe,
    OrderCreatePipe,
  ],
})
export class OrdersModule {}
