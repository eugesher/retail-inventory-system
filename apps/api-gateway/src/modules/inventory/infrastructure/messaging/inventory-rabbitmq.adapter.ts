import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IPage,
  IReservationReleasePayload,
  IReservationReleaseResult,
  IStockAdjustPayload,
  IStockLocationsListPayload,
  IStockMovementListPayload,
  IStockReceivePayload,
  IStockTransferPayload,
  IStockTransferResult,
  IVariantStockGetPayload,
  StockLevelView,
  StockLocationView,
  StockMovementView,
  VariantStockView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  IAdjustStockCommand,
  IGetVariantStockQuery,
  IInventoryGatewayPort,
  IListLocationsQuery,
  IReceiveStockCommand,
  ITransferStockCommand,
} from '../../application/ports';

// The single `ClientProxy` holder for the inventory gateway module (ADR-009 /
// ADR-020). Each method materializes the RPC with `firstValueFrom` and stitches
// the transport-level `correlationId` onto the wire payload; everything else in
// the module depends on `IInventoryGatewayPort`, never on `@nestjs/microservices`.
@Injectable()
export class InventoryRabbitmqAdapter implements IInventoryGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async getVariantStock(
    query: IGetVariantStockQuery,
    correlationId: string,
  ): Promise<VariantStockView> {
    return firstValueFrom(
      this.client.send<VariantStockView, IVariantStockGetPayload>(
        ROUTING_KEYS.INVENTORY_STOCK_LEVEL_GET,
        { ...query, correlationId },
      ),
    );
  }

  public async listLocations(
    query: IListLocationsQuery,
    correlationId: string,
  ): Promise<StockLocationView[]> {
    return firstValueFrom(
      this.client.send<StockLocationView[], IStockLocationsListPayload>(
        ROUTING_KEYS.INVENTORY_LOCATION_LIST,
        { ...query, correlationId },
      ),
    );
  }

  public async receiveStock(
    command: IReceiveStockCommand,
    correlationId: string,
  ): Promise<StockLevelView> {
    return firstValueFrom(
      this.client.send<StockLevelView, IStockReceivePayload>(
        ROUTING_KEYS.INVENTORY_STOCK_LEVEL_RECEIVE,
        { ...command, correlationId },
      ),
    );
  }

  public async adjustStock(
    command: IAdjustStockCommand,
    correlationId: string,
  ): Promise<StockLevelView> {
    return firstValueFrom(
      this.client.send<StockLevelView, IStockAdjustPayload>(
        ROUTING_KEYS.INVENTORY_STOCK_LEVEL_ADJUST,
        { ...command, correlationId },
      ),
    );
  }

  public async transferStock(
    command: ITransferStockCommand,
    correlationId: string,
  ): Promise<IStockTransferResult> {
    return firstValueFrom(
      this.client.send<IStockTransferResult, IStockTransferPayload>(
        ROUTING_KEYS.INVENTORY_STOCK_LEVEL_TRANSFER,
        { ...command, correlationId },
      ),
    );
  }

  // The audit-list and manual-release RPCs take the FULL wire payload (the
  // controller already folded the REQUIRED `correlationId` + the release's
  // `reason` / `actorId`), so unlike the methods above there is no separate
  // `correlationId` argument to stitch — the payload is sent verbatim.
  public async listVariantMovements(
    payload: IStockMovementListPayload,
  ): Promise<IPage<StockMovementView>> {
    return firstValueFrom(
      this.client.send<IPage<StockMovementView>, IStockMovementListPayload>(
        ROUTING_KEYS.INVENTORY_STOCK_MOVEMENT_LIST,
        payload,
      ),
    );
  }

  public async releaseReservation(
    payload: IReservationReleasePayload,
  ): Promise<IReservationReleaseResult> {
    return firstValueFrom(
      this.client.send<IReservationReleaseResult, IReservationReleasePayload>(
        ROUTING_KEYS.INVENTORY_RESERVATION_RELEASE,
        payload,
      ),
    );
  }
}
