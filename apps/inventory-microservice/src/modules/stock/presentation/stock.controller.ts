import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IReservationReleasePayload,
  IReservationReleaseResult,
  IReservationReservePayload,
  IStockAdjustPayload,
  IStockLocationsListPayload,
  IStockReceivePayload,
  IVariantStockGetPayload,
  ReservationView,
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
  ReleaseReservationUseCase,
  ReserveStockUseCase,
} from '../application/use-cases';

@Controller()
export class StockController {
  constructor(
    private readonly queryAvailability: QueryAvailabilityUseCase,
    private readonly listLocations: ListLocationsUseCase,
    private readonly receiveStock: ReceiveStockUseCase,
    private readonly adjustStock: AdjustStockUseCase,
    private readonly reserveStock: ReserveStockUseCase,
    private readonly releaseReservation: ReleaseReservationUseCase,
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

  // Reserve Stock (ADR-030): holds units for a cart against the no-oversell
  // guard. An over-request is a 409 `OUT_OF_STOCK` (carrying `details.available`),
  // mapped by the `InventoryRpcExceptionFilter`.
  @MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_RESERVE)
  public handleReserve(@Payload() payload: IReservationReservePayload): Promise<ReservationView> {
    return this.reserveStock.execute(payload);
  }

  // Release Reservation (ADR-030): returns held units to `available` and writes a
  // `release` movement. Selector is `reservationId` (one row) or `cartId`
  // (+ optional variantId/stockLocationId, all matching active rows).
  @MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_RELEASE)
  public handleRelease(
    @Payload() payload: IReservationReleasePayload,
  ): Promise<IReservationReleaseResult> {
    return this.releaseReservation.execute(payload);
  }
}
