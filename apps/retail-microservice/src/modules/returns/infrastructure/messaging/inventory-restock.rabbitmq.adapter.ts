import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  IRestockFromReturnPayload,
  IRestockFromReturnResult,
} from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  ROUTING_KEYS,
  sendPreservingRpcError,
} from '@retail-inventory-system/messaging';

import { IInventoryRestockGatewayPort } from '../../application/ports';

@Injectable()
export class InventoryRestockRabbitmqAdapter implements IInventoryRestockGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

  public async restockFromReturn(
    payload: IRestockFromReturnPayload,
  ): Promise<IRestockFromReturnResult> {
    return sendPreservingRpcError<IRestockFromReturnResult, IRestockFromReturnPayload>(
      this.inventoryClient,
      ROUTING_KEYS.INVENTORY_STOCK_RESTOCK_FROM_RETURN,
      payload,
    );
  }
}
