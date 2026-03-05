import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { MicroserviceClientInventoryModule } from '@retail-inventory-system/common';
import { Order } from '../../common/entities';
import { OrderCreateService } from './providers';
import { OrderController } from './order.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Order]), MicroserviceClientInventoryModule],
  controllers: [OrderController],
  providers: [OrderCreateService],
})
export class OrderModule {}
