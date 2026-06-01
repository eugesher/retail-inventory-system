import { Module } from '@nestjs/common';

import { MicroserviceClientRetailModule } from '@retail-inventory-system/messaging';

import { RETAIL_GATEWAY_PORT } from './application/ports';
import { ConfirmOrderUseCase, CreateOrderUseCase } from './application/use-cases';
import { OrderConfirmPipe } from './presentation/pipes';
import { OrderController } from './presentation';
import { RetailRabbitmqAdapter } from './infrastructure/messaging';

@Module({
  imports: [MicroserviceClientRetailModule],
  controllers: [OrderController],
  providers: [
    OrderConfirmPipe,
    ConfirmOrderUseCase,
    CreateOrderUseCase,
    { provide: RETAIL_GATEWAY_PORT, useClass: RetailRabbitmqAdapter },
  ],
})
export class RetailModule {}
