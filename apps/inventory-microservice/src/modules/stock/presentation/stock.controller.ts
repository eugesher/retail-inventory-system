import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  IAllocationCancelPayload,
  IAllocationResult,
  ICommitSalePayload,
  ICommitSaleResult,
  IPage,
  IReservationAllocatePayload,
  IReservationReleasePayload,
  IReservationReleaseResult,
  IReservationReservePayload,
  IReservationSweepPayload,
  IReservationSweepResult,
  IRestockFromReturnPayload,
  IRestockFromReturnResult,
  IStockAdjustPayload,
  IStockLocationsListPayload,
  IStockMovementListPayload,
  IStockReceivePayload,
  IStockTransferPayload,
  IStockTransferResult,
  IVariantStockGetPayload,
  ReservationView,
  StockLevelView,
  StockLocationView,
  StockMovementView,
  VariantStockView,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  AdjustStockUseCase,
  AllocateStockUseCase,
  CancelAllocationUseCase,
  CommitSaleUseCase,
  ListLocationsUseCase,
  ListStockMovementsUseCase,
  QueryAvailabilityUseCase,
  ReceiveStockUseCase,
  ReleaseReservationUseCase,
  ReserveStockUseCase,
  RestockFromReturnUseCase,
  SweepExpiredReservationsUseCase,
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
    private readonly sweepExpiredReservations: SweepExpiredReservationsUseCase,
    private readonly allocateStock: AllocateStockUseCase,
    private readonly cancelAllocation: CancelAllocationUseCase,
    private readonly commitSale: CommitSaleUseCase,
    private readonly restockFromReturn: RestockFromReturnUseCase,
    private readonly transferStock: TransferStockUseCase,
    private readonly listStockMovements: ListStockMovementsUseCase,
  ) {}

  // Every handler below is a one-line hand-off: the use case owns the behaviour, and
  // `InventoryRpcExceptionFilter` owns the code → HTTP status mapping. Neither is restated here —
  // the comments record only what a reader would get wrong.
  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_GET)
  public handleStockLevelGet(
    @Payload() payload: IVariantStockGetPayload,
  ): Promise<VariantStockView> {
    return this.queryAvailability.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.INVENTORY_LOCATION_LIST)
  public handleLocationList(
    @Payload() payload: IStockLocationsListPayload,
  ): Promise<StockLocationView[]> {
    return this.listLocations.execute(payload);
  }

  // **An unknown variant is an empty page, not a `404`.** A read that finds nothing has still
  // answered the question. Uncached, deliberately — an operator's audit query must not be served a
  // stale timeline.
  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_MOVEMENT_LIST)
  public handleStockMovementList(
    @Payload() payload: IStockMovementListPayload,
  ): Promise<IPage<StockMovementView>> {
    return this.listStockMovements.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_RECEIVE)
  public handleStockReceive(@Payload() payload: IStockReceivePayload): Promise<StockLevelView> {
    return this.receiveStock.execute(payload);
  }

  // The `reasonCode` is **mandatory**, unlike on every other write — an adjustment is the one
  // operation with no business event behind it, so the reason is the only record of why.
  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_ADJUST)
  public handleStockAdjust(@Payload() payload: IStockAdjustPayload): Promise<StockLevelView> {
    return this.adjustStock.execute(payload);
  }

  // **A transfer is two `adjustment` movements, not a movement type of its own.** They share a
  // `transfer` reference id, which is the only thing pairing them — nothing in the ledger says
  // "these units went from A to B", and there is no in-transit state between the two locations.
  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_TRANSFER)
  public handleStockTransfer(
    @Payload() payload: IStockTransferPayload,
  ): Promise<IStockTransferResult> {
    return this.transferStock.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_RESERVE)
  public handleReserve(@Payload() payload: IReservationReservePayload): Promise<ReservationView> {
    return this.reserveStock.execute(payload);
  }

  // **The two selectors fail differently, and that is deliberate.** By `reservationId`, naming a
  // hold that does not exist is a `404`; by `cartId`, matching nothing is an idempotent no-op —
  // removing a cart line twice must not error.
  @MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_RELEASE)
  public handleRelease(
    @Payload() payload: IReservationReleasePayload,
  ): Promise<IReservationReleaseResult> {
    return this.releaseReservation.execute(payload);
  }

  // The on-demand twin of the timer, and it runs **the same use case** — there is no second sweep
  // implementation, so an operator sweep and a scheduled one cannot drift apart. The only
  // difference is `actorId`: a human triggered this one, and their id lands on every `release`
  // ledger row the invocation writes.
  //
  // `batchSize` is an override the use case **clamps** into `[1, RESERVATION_SWEEP_BATCH_SIZE]` —
  // the configured value is a ceiling an operator cannot raise.
  @MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_SWEEP)
  public handleReservationSweep(
    @Payload() payload: IReservationSweepPayload,
  ): Promise<IReservationSweepResult> {
    return this.sweepExpiredReservations.execute(payload);
  }

  // **Called from inside retail's place transaction, before it commits** — so a rejection here
  // rolls the whole order placement back. That is the point: an order that cannot get its stock
  // must not exist. All-lines-atomic, with a direct-allocation fallback when a line has no hold.
  @MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_ALLOCATE)
  public handleAllocate(
    @Payload() payload: IReservationAllocatePayload,
  ): Promise<IAllocationResult> {
    return this.allocateStock.execute(payload);
  }

  // **Idempotency here is key-guarded** (ADR-057). It used to be quantity-guarded, and the claim
  // that went with it — *"a replayed cancel simply finds nothing left to release"* — was false:
  // `quantity_allocated` is shared per `(variant, location)`, so a redelivered cancel arriving
  // after ANOTHER order allocated the same level passes the quantity check and releases that
  // order's units, overstating `available` and overselling. The caller now mints an
  // `operationKey` per cancellation and `UC_STOCK_MOVEMENT_DEDUPE` refuses the second write.
  // An over-cancel is still refused on its own terms (`STOCK_RESULT_NEGATIVE`, 409). Resolves
  // `{ cancelled }`, the line count, not the unit count.
  @MessagePattern(ROUTING_KEYS.INVENTORY_ALLOCATION_CANCEL)
  public handleCancelAllocation(
    @Payload() payload: IAllocationCancelPayload,
  ): Promise<{ cancelled: number }> {
    return this.cancelAllocation.execute(payload);
  }

  // **Called AFTER retail's ship transaction has committed**, not inside it — the opposite of
  // Allocate above. So a failure here cannot unship anything, and an RMQ redelivery is a normal
  // event rather than an anomaly. That is what `fulfillmentId` is for: it makes the replay a no-op.
  //
  // No gateway HTTP route. Retail drives it.
  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_COMMIT_SALE)
  public handleCommitSale(@Payload() payload: ICommitSalePayload): Promise<ICommitSaleResult> {
    return this.commitSale.execute(payload);
  }

  // The mirror of Commit Sale: called **after** retail's inspect has committed, idempotent on
  // `returnRequestId` for the same reason. **Only `restock`-disposition lines arrive here** —
  // scrapped and quarantined goods came back to the warehouse but never to the shelf, and inventory
  // never hears about them.
  //
  // No gateway HTTP route. Retail drives it.
  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_RESTOCK_FROM_RETURN)
  public handleRestockFromReturn(
    @Payload() payload: IRestockFromReturnPayload,
  ): Promise<IRestockFromReturnResult> {
    return this.restockFromReturn.execute(payload);
  }
}
