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

  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_LEVEL_ADJUST)
  public handleStockAdjust(@Payload() payload: IStockAdjustPayload): Promise<StockLevelView> {
    return this.adjustStock.execute(payload);
  }

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

  @MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_RELEASE)
  public handleRelease(
    @Payload() payload: IReservationReleasePayload,
  ): Promise<IReservationReleaseResult> {
    return this.releaseReservation.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_SWEEP)
  public handleReservationSweep(
    @Payload() payload: IReservationSweepPayload,
  ): Promise<IReservationSweepResult> {
    return this.sweepExpiredReservations.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.INVENTORY_RESERVATION_ALLOCATE)
  public handleAllocate(
    @Payload() payload: IReservationAllocatePayload,
  ): Promise<IAllocationResult> {
    return this.allocateStock.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.INVENTORY_ALLOCATION_CANCEL)
  public handleCancelAllocation(
    @Payload() payload: IAllocationCancelPayload,
  ): Promise<{ cancelled: number }> {
    return this.cancelAllocation.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_COMMIT_SALE)
  public handleCommitSale(@Payload() payload: ICommitSalePayload): Promise<ICommitSaleResult> {
    return this.commitSale.execute(payload);
  }

  @MessagePattern(ROUTING_KEYS.INVENTORY_STOCK_RESTOCK_FROM_RETURN)
  public handleRestockFromReturn(
    @Payload() payload: IRestockFromReturnPayload,
  ): Promise<IRestockFromReturnResult> {
    return this.restockFromReturn.execute(payload);
  }
}
