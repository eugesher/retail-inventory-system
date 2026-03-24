import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MicroserviceClientInventoryModule } from '@retail-inventory-system/common';
import { Customer, Order } from '../../common/entities';
import { OrderCreatePipe } from './pipes';
import { OrderConfirmService, OrderCreateService, OrderGetService } from './providers';
import { OrderController } from './order.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Order, Customer]), MicroserviceClientInventoryModule],
  controllers: [OrderController],
  providers: [OrderCreatePipe, OrderCreateService, OrderConfirmService, OrderGetService],
})
export class OrderModule {}
