import { Module } from '@nestjs/common';

import { MicroserviceClientInventoryModule } from '@retail-inventory-system/messaging';

import { INVENTORY_GATEWAY_PORT } from './application/ports';
import { GetVariantStockUseCase, ListLocationsUseCase } from './application/use-cases';
import { InventoryRabbitmqAdapter } from './infrastructure/messaging';
import { InventoryController } from './presentation';

// Gateway-side port→adapter module fronting the inventory microservice's read
// path over HTTP at `/api/inventory` (ADR-009). Named after the downstream
// service, not the URL prefix. `InventoryRabbitmqAdapter` (the sole `ClientProxy`
// holder) backs `INVENTORY_GATEWAY_PORT`; the two read use cases and the
// controller depend on the port symbol only.
@Module({
  imports: [MicroserviceClientInventoryModule],
  controllers: [InventoryController],
  providers: [
    GetVariantStockUseCase,
    ListLocationsUseCase,
    { provide: INVENTORY_GATEWAY_PORT, useClass: InventoryRabbitmqAdapter },
  ],
})
export class InventoryModule {}
