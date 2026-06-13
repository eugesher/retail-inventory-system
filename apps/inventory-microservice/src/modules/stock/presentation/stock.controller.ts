import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IAllocationCancelPayload,
  IAllocationResult,
  IReservationAllocatePayload,
  IReservationReleasePayload,
  IReservationReleaseResult,
  IReservationReservePayload,
  IStockAdjustPayload,
  IStockLocationsListPayload,
  IStockReceivePayload,
  IStockTransferPayload,
  IStockTransferResult,
  IVariantStockGetPayload,
  ReservationView,
  StockLevelView,
  StockLocationView,
  VariantStockView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  AdjustStockUseCase,
  AllocateStockUseCase,
  CancelAllocationUseCase,
  ListLocationsUseCase,
  QueryAvailabilityUseCase,
  ReceiveStockUseCase,
  ReleaseReservationUseCase,
  ReserveStockUseCase,
  TransferStockUseCase,
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
    private readonly allocateStock: AllocateStockUseCase,
    private readonly cancelAllocation: CancelAllocationUseCase,
    private readonly transferStock: TransferStockUseCase,
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

  // Transfer Stock write path (ADR-030): moves on-hand between two locations of one
  // variant atomically — two version-checked `StockLevel` writes + two paired
  // `adjustment` movements (sharing a `transfer` reference) in one transaction. A
  // bad quantity / same-location is a 400; an over-transfer (source below zero) is a
  // 409 `STOCK_RESULT_NEGATIVE`; an unknown/inactive location reuses the existing
  // location codes — all mapped by the `InventoryRpcExceptionFilter`.
  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_TRANSFER)
  public handleStockTransfer(
    @Payload() payload: IStockTransferPayload,
  ): Promise<IStockTransferResult> {
    return this.transferStock.execute(payload);
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

  // Allocate Stock (ADR-030): converts a cart's holds into an order's allocations
  // at place-time (refresh-then-commit for a stale-but-held hold; direct-allocation
  // fallback when no hold exists). All-lines-atomic; an over-allocation is a 409
  // `OUT_OF_STOCK` (carrying `details.available`). Invoked by the retail place
  // transaction pre-commit (a rejection rolls the place back).
  @MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_ALLOCATE)
  public handleAllocate(
    @Payload() payload: IReservationAllocatePayload,
  ): Promise<IAllocationResult> {
    return this.allocateStock.execute(payload);
  }

  // Cancel Allocation (ADR-030): reverses an order's allocation, returning the units
  // to `available` and writing a `release` movement per line. Idempotency is
  // quantity-guarded — an over-cancel is a 409 `STOCK_RESULT_NEGATIVE`. Resolves
  // `{ cancelled }` (the line count) over RMQ. No in-repo caller yet — the later
  // order-cancel flow + the place-failure compensation invoke it.
  @MessagePattern(ROUTING_KEYS.INVENTORY_ALLOCATION_CANCEL)
  public handleCancelAllocation(
    @Payload() payload: IAllocationCancelPayload,
  ): Promise<{ cancelled: number }> {
    return this.cancelAllocation.execute(payload);
  }
}
