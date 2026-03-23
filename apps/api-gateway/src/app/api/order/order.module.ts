import { Module } from '@nestjs/common';

import { MicroserviceClientRetailModule } from '@retail-inventory-system/common';
import { OrderConfirmPipe } from './pipes';
import { OrderConfirmService, OrderCreateService } from './providers';
import { OrderController } from './order.controller';

@Module({
  imports: [MicroserviceClientRetailModule],
  controllers: [OrderController],
  providers: [OrderConfirmPipe, OrderConfirmService, OrderCreateService],
})
export class OrderModule {}
