import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IStockAdjustPayload,
  IStockLocationsListPayload,
  IStockReceivePayload,
  IVariantStockGetPayload,
  StockLevelView,
  StockLocationView,
  VariantStockView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import {
  IAdjustStockCommand,
  IGetVariantStockQuery,
  IInventoryGatewayPort,
  IListLocationsQuery,
  IReceiveStockCommand,
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
}
