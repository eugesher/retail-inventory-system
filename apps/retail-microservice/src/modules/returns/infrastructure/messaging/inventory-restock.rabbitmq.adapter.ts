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

// The returns context's outbound seam onto the inventory restock RPC
// (`inventory.stock.restock-from-return`, ADR-032), and the only `ClientProxy` holder
// besides the events publisher (ADR-009 / ADR-020). The Inspect & Disposition use case
// depends on `IInventoryRestockGatewayPort`, never on `@nestjs/microservices`. The RPC is
// sent through the `INVENTORY_MICROSERVICE` client so it lands on `inventory_queue`, where
// the stock controller serves it (the `OrderCommitSaleRabbitmqAdapter` precedent).
@Injectable()
export class InventoryRestockRabbitmqAdapter implements IInventoryRestockGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

  public async restockFromReturn(
    payload: IRestockFromReturnPayload,
  ): Promise<IRestockFromReturnResult> {
    // Restock runs AFTER the local inspection commit, so a rejection here is handled by
    // the use case (retry then log-and-replay) rather than rolling the inspection back.
    // Still, `sendPreservingRpcError` wraps the rejection in an `RpcException` so the
    // upstream `{ statusCode, message, code, details }` survives intact for the use case's
    // logs (the inventory restock is idempotent on `returnRequestId`, so a replay is safe).
    return sendPreservingRpcError<IRestockFromReturnResult, IRestockFromReturnPayload>(
      this.inventoryClient,
      ROUTING_KEYS.INVENTORY_STOCK_RESTOCK_FROM_RETURN,
      payload,
    );
  }
}
