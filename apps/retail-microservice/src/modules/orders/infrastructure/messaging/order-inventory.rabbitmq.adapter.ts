import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  IAllocationCancelPayload,
  IAllocationResult,
  IReservationAllocatePayload,
} from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  ROUTING_KEYS,
  sendPreservingRpcError,
} from '@retail-inventory-system/messaging';

import { IOrderInventoryGatewayPort } from '../../application/ports';

// The orders context's outbound seam onto the inventory reservation surface
// (`inventory.reservation.allocate` / `inventory.allocation.cancel`, ADR-030 §4),
// and one of the module's `ClientProxy` holders (ADR-009 / ADR-020). Place Order
// depends on `IOrderInventoryGatewayPort`, never on `@nestjs/microservices`. Both
// RPCs are sent through the `INVENTORY_MICROSERVICE` client so they land on
// `inventory_queue`, where the stock controller serves them.
@Injectable()
export class OrderInventoryRabbitmqAdapter implements IOrderInventoryGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

  public async allocateStock(payload: IReservationAllocatePayload): Promise<IAllocationResult> {
    // Allocate runs inside the place transaction. A rejection (e.g. an
    // expired-and-released hold + insufficient fallback stock →
    // `INVENTORY_OUT_OF_STOCK`) must reach the gateway with its typed `code` +
    // `details.available` intact, so it propagates out of the tx callback and rolls
    // the whole place back. `sendPreservingRpcError` wraps the rejection in an
    // `RpcException` so the upstream `{ statusCode, message, code, details }` survives.
    return sendPreservingRpcError<IAllocationResult, IReservationAllocatePayload>(
      this.inventoryClient,
      ROUTING_KEYS.INVENTORY_RESERVATION_ALLOCATE,
      payload,
    );
  }

  public async cancelAllocation(payload: IAllocationCancelPayload): Promise<void> {
    // The cancel RPC resolves `{ cancelled: number }`, but the compensation caller
    // discards it (best-effort), so the port surface is `void`.
    await sendPreservingRpcError<{ cancelled: number }, IAllocationCancelPayload>(
      this.inventoryClient,
      ROUTING_KEYS.INVENTORY_ALLOCATION_CANCEL,
      payload,
    );
  }
}
