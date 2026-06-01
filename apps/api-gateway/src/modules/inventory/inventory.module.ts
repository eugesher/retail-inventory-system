import { Module } from '@nestjs/common';

import { MicroserviceClientInventoryModule } from '@retail-inventory-system/messaging';

import { INVENTORY_GATEWAY_PORT } from './application/ports';
import { GetProductStockUseCase } from './application/use-cases';
import { InventoryRabbitmqAdapter } from './infrastructure/messaging';
import { ProductController } from './presentation';

@Module({
  imports: [MicroserviceClientInventoryModule],
  controllers: [ProductController],
  providers: [
    GetProductStockUseCase,
    { provide: INVENTORY_GATEWAY_PORT, useClass: InventoryRabbitmqAdapter },
  ],
})
export class InventoryModule {}
