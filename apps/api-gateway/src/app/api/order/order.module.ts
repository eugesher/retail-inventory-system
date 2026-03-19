import { Module } from '@nestjs/common';

import { MicroserviceClientRetailModule } from '@retail-inventory-system/common';
import { OrderController } from './order.controller';

@Module({
  imports: [MicroserviceClientRetailModule],
  controllers: [OrderController],
})
export class OrderModule {}
