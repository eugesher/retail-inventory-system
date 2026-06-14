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
  TransferStockUseCase,
} from './application/use-cases';
import { InventoryRabbitmqAdapter } from './infrastructure/messaging';
import { InventoryController } from './presentation';

// Gateway-side port→adapter module fronting the inventory microservice's read +
// write path over HTTP at `/api/inventory` (ADR-009). Named after the downstream
// service, not the URL prefix. `InventoryRabbitmqAdapter` (the sole `ClientProxy`
// holder) backs `INVENTORY_GATEWAY_PORT`; the read + write use cases and the
// controller depend on the port symbol only.
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
    { provide: INVENTORY_GATEWAY_PORT, useClass: InventoryRabbitmqAdapter },
  ],
})
export class InventoryModule {}
