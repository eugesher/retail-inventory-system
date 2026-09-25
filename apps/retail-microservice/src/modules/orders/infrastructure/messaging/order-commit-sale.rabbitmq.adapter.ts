import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import { ICommitSalePayload, ICommitSaleResult } from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  ROUTING_KEYS,
  sendPreservingRpcError,
} from '@retail-inventory-system/messaging';

import { IOrderCommitSaleGatewayPort } from '../../application/ports';

@Injectable()
export class OrderCommitSaleRabbitmqAdapter implements IOrderCommitSaleGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

  public async commitSale(payload: ICommitSalePayload): Promise<ICommitSaleResult> {
    return sendPreservingRpcError<ICommitSaleResult, ICommitSalePayload>(
      this.inventoryClient,
      ROUTING_KEYS.INVENTORY_STOCK_COMMIT_SALE,
      payload,
    );
  }
}
