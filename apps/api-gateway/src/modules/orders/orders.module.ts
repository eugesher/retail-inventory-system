import { Module } from '@nestjs/common';

import { MicroserviceClientRetailModule } from '@retail-inventory-system/messaging';

import { ORDERS_GATEWAY_PORT } from './application/ports';
import {
  CancelLineUseCase,
  CancelOrderUseCase,
  CapturePaymentUseCase,
  CreateFulfillmentUseCase,
  GetOrderUseCase,
  IssueRefundUseCase,
  ListFulfillmentsUseCase,
  ListMyOrdersUseCase,
  ListRefundsUseCase,
  MarkDeliveredUseCase,
  ShipFulfillmentUseCase,
} from './application/use-cases';
import { OrdersRabbitmqAdapter } from './infrastructure/messaging';
import { OrdersController, RefundsController } from './presentation';

@Module({
  imports: [MicroserviceClientRetailModule],
  controllers: [OrdersController, RefundsController],
  providers: [
    GetOrderUseCase,
    ListMyOrdersUseCase,
    CapturePaymentUseCase,
    CreateFulfillmentUseCase,
    ShipFulfillmentUseCase,
    MarkDeliveredUseCase,
    ListFulfillmentsUseCase,
    CancelOrderUseCase,
    CancelLineUseCase,
    IssueRefundUseCase,
    ListRefundsUseCase,
    { provide: ORDERS_GATEWAY_PORT, useClass: OrdersRabbitmqAdapter },
  ],
})
export class OrdersModule {}
