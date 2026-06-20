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

// Gateway-side port→adapter module fronting the retail microservice's order read +
// capture + fulfillment + cancel + refund RPCs over HTTP at `/api/orders` (ADR-009,
// ADR-031, ADR-032). Named after the downstream service. `OrdersRabbitmqAdapter` (the
// sole `ClientProxy` holder) backs `ORDERS_GATEWAY_PORT`; the use cases and both
// controllers depend on the port symbol only. The order-scoped refund routes live on a
// second controller (`RefundsController`, same `orders` prefix) — one-concern-shaped, the
// catalog category/media multi-controller precedent. The gateway holds no order state of
// its own — `MicroserviceClientRetailModule` provides the `RETAIL_MICROSERVICE` client
// that targets `retail_queue` (the orders controller serves the order + fulfillment +
// refund RPCs there). There is no `domain/`: every route folds the verified
// `@CurrentUser()` identity into the command and the retail use case enforces the
// owner(-or-staff) check (ADR-028 §7).
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
