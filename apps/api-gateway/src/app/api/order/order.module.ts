import { Module } from '@nestjs/common';

import { RetailMicroserviceClientModule } from '@retail-inventory-system/microservices';
import { OrderCreateService } from './providers';
import { OrderController } from './order.controller';

@Module({
  imports: [RetailMicroserviceClientModule],
  controllers: [OrderController],
  providers: [OrderCreateService],
})
export class OrderModule {}
