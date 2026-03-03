import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { InventoryMicroserviceClientModule } from '@retail-inventory-system/microservices';
import { Order } from '../../common/entities';
import { OrderCreateService } from './providers';
import { OrderController } from './order.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Order]), InventoryMicroserviceClientModule],
  controllers: [OrderController],
  providers: [OrderCreateService],
})
export class OrderModule {}
