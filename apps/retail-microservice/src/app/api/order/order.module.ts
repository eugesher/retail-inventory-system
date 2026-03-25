import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MicroserviceClientInventoryModule } from '@retail-inventory-system/common';
import { Customer, Order } from '../../common/entities';
import { OrderConfirmPipe, OrderCreatePipe } from './pipes';
import { OrderConfirmService, OrderCreateService, OrderGetService } from './providers';
import { OrderController } from './order.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Order, Customer]), MicroserviceClientInventoryModule],
  controllers: [OrderController],
  providers: [
    OrderConfirmPipe,
    OrderCreatePipe,
    OrderConfirmService,
    OrderCreateService,
    OrderGetService,
  ],
})
export class OrderModule {}
