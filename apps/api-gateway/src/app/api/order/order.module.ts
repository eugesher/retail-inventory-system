import { Module } from '@nestjs/common';

import { MicroserviceClientRetailModule } from '@retail-inventory-system/common';
import { OrderController } from './order.controller';
import { OrderConfirmPipe } from './pipes';

@Module({
  imports: [MicroserviceClientRetailModule],
  controllers: [OrderController],
  providers: [OrderConfirmPipe],
})
export class OrderModule {}
