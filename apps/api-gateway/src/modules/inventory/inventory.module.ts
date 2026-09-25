import { Module } from '@nestjs/common';

import { MicroserviceClientInventoryModule } from '@retail-inventory-system/messaging';

import { INVENTORY_GATEWAY_PORT } from './application/ports';
import {
  AdjustStockUseCase,
  GetVariantStockUseCase,
  ListLocationsUseCase,
  ListVariantMovementsUseCase,
  ReceiveStockUseCase,
  ReleaseReservationUseCase,
  SweepReservationsUseCase,
  TransferStockUseCase,
} from './application/use-cases';
import { InventoryRabbitmqAdapter } from './infrastructure/messaging';
import { InventoryController } from './presentation';

@Module({
  imports: [MicroserviceClientInventoryModule],
  controllers: [InventoryController],
  providers: [
    GetVariantStockUseCase,
    ListLocationsUseCase,
    ReceiveStockUseCase,
    AdjustStockUseCase,
    TransferStockUseCase,
    ListVariantMovementsUseCase,
    ReleaseReservationUseCase,
    SweepReservationsUseCase,
    { provide: INVENTORY_GATEWAY_PORT, useClass: InventoryRabbitmqAdapter },
  ],
})
export class InventoryModule {}
