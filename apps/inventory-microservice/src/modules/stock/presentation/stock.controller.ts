import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';

import {
  IProductStockOrderConfirmPayload,
  IStockAdjustPayload,
  IStockLocationsListPayload,
  IStockReceivePayload,
  IVariantStockGetPayload,
  StockLevelView,
  StockLocationView,
  VariantStockView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  AdjustStockUseCase,
  ListLocationsUseCase,
  QueryAvailabilityUseCase,
  ReceiveStockUseCase,
} from '../application/use-cases';

@Controller()
export class StockController {
  constructor(
    private readonly queryAvailability: QueryAvailabilityUseCase,
    private readonly listLocations: ListLocationsUseCase,
    private readonly receiveStock: ReceiveStockUseCase,
    private readonly adjustStock: AdjustStockUseCase,
  ) {}

  // Read path on the new model (ADR-027): per-variant availability across the
  // requested stock locations.
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

  // Receive Stock write path (ADR-027): raises on-hand by a positive quantity.
  // A domain rejection (e.g. an inactive/unknown location) is terminated by the
  // `InventoryRpcExceptionFilter` into a `{ statusCode, ... }` the gateway maps.
  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_RECEIVE)
  public handleStockReceive(@Payload() payload: IStockReceivePayload): Promise<StockLevelView> {
    return this.receiveStock.execute(payload);
  }

  // Adjust Stock write path (ADR-027): applies a signed delta with a mandatory
  // reasonCode. A result that would go below zero is rejected as a 409 (mapped by
  // the `InventoryRpcExceptionFilter`).
  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_ADJUST)
  public handleStockAdjust(@Payload() payload: IStockAdjustPayload): Promise<StockLevelView> {
    return this.adjustStock.execute(payload);
  }

  // The `inventory.order.confirm` seam is preserved as an explicit deprecation
  // error rather than removed outright, so any lingering caller resolves to a
  // typed error instead of an RPC timeout. Stock reservation now belongs to the
  // inventory-reservation capability; the whole seam (this handler + the
  // `IProductStockOrderConfirmPayload` contract) is removed when that capability
  // lands. The legacy retail-side caller has already been torn down; the
  // `@Payload()` signature is kept only so the reserved contract still
  // type-checks (ADR-027).
  @MessagePattern(ROUTING_KEYS.INVENTORY_ORDER_CONFIRM)
  public handleOrderConfirm(@Payload() payload: IProductStockOrderConfirmPayload): never {
    void payload;
    throw new RpcException(
      'inventory.order.confirm is deprecated; reservation is handled by the inventory-reservation capability',
    );
  }
}
