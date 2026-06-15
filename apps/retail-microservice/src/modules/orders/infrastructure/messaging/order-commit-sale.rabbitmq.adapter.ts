import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import { ICommitSalePayload, ICommitSaleResult } from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  ROUTING_KEYS,
  sendPreservingRpcError,
} from '@retail-inventory-system/messaging';

import { IOrderCommitSaleGatewayPort } from '../../application/ports';

// The orders context's outbound seam onto the inventory commit-sale RPC
// (`inventory.stock.commit-sale`, ADR-031), and one of the module's `ClientProxy`
// holders (ADR-009 / ADR-020). The Ship use case depends on
// `IOrderCommitSaleGatewayPort`, never on `@nestjs/microservices`. The RPC is sent
// through the `INVENTORY_MICROSERVICE` client so it lands on `inventory_queue`, where
// the stock controller serves it (the `OrderInventoryRabbitmqAdapter` precedent).
@Injectable()
export class OrderCommitSaleRabbitmqAdapter implements IOrderCommitSaleGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

  public async commitSale(payload: ICommitSalePayload): Promise<ICommitSaleResult> {
    // Commit Sale runs AFTER the local ship commit, so a rejection here is handled by
    // the use case (retry then log-and-replay) rather than rolling the ship back. Still,
    // `sendPreservingRpcError` wraps the rejection in an `RpcException` so the upstream
    // `{ statusCode, message, code, details }` survives intact for the use case's logs.
    return sendPreservingRpcError<ICommitSaleResult, ICommitSalePayload>(
      this.inventoryClient,
      ROUTING_KEYS.INVENTORY_STOCK_COMMIT_SALE,
      payload,
    );
  }
}
