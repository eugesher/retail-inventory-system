import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';

import {
  IProductStockOrderConfirmPayload,
  IStockLocationsListPayload,
  IVariantStockGetPayload,
  StockLocationView,
  VariantStockView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { ListLocationsUseCase, QueryAvailabilityUseCase } from '../application/use-cases';

@Controller()
export class StockController {
  constructor(
    private readonly queryAvailability: QueryAvailabilityUseCase,
    private readonly listLocations: ListLocationsUseCase,
  ) {}

  // Read path on the new model (ADR-027): per-variant availability across the
  // requested stock locations. No caller exists until the gateway endpoint lands
  // — this handler is reachable directly over RMQ today.
  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_GET)
  public handleStockLevelGet(
    @Payload() payload: IVariantStockGetPayload,
  ): Promise<VariantStockView> {
    return this.queryAvailability.execute(payload);
  }

  // Lists the stock locations (optionally active-only).
  @MessagePattern(ROUTING_KEYS.INVENTORY_LOCATION_LIST)
  public handleLocationList(
    @Payload() payload: IStockLocationsListPayload,
  ): Promise<StockLocationView[]> {
    return this.listLocations.execute(payload);
  }

  // The `inventory.order.confirm` seam is preserved as an explicit deprecation
  // error rather than removed outright, so the retail confirm flow resolves to
  // a typed error instead of an RPC timeout. Stock reservation now belongs to
  // the inventory-reservation capability; the whole seam is removed when that
  // capability lands. The `@Payload()` signature keeps the retail adapter's
  // compile-time contract intact (ADR-013 §7).
  @MessagePattern(ROUTING_KEYS.INVENTORY_ORDER_CONFIRM)
  public handleOrderConfirm(@Payload() payload: IProductStockOrderConfirmPayload): never {
    void payload;
    throw new RpcException(
      'inventory.order.confirm is deprecated; reservation is handled by the inventory-reservation capability',
    );
  }
}
