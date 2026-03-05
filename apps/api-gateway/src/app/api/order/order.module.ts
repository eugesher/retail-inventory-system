import { Module } from '@nestjs/common';

import { MicroserviceClientRetailModule } from '@retail-inventory-system/common';
import { OrderCreateService } from './providers';
import { OrderController } from './order.controller';

@Module({
  imports: [MicroserviceClientRetailModule],
  controllers: [OrderController],
  providers: [OrderCreateService],
})
export class OrderModule {}
