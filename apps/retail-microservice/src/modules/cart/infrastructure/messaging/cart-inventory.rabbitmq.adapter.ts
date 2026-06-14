import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';

import {
  IReservationReleasePayload,
  IReservationReleaseResult,
  IReservationReservePayload,
  ReservationView,
} from '@retail-inventory-system/contracts';
import {
  MicroserviceClientTokenEnum,
  ROUTING_KEYS,
  sendPreservingRpcError,
} from '@retail-inventory-system/messaging';

import { ICartInventoryGatewayPort } from '../../application/ports';

// The cart context's outbound seam onto the inventory reservation surface
// (`inventory.reservation.reserve` / `.release`, ADR-030), and one of the module's
// `ClientProxy` holders (ADR-009 / ADR-020). The Add/Change/Remove use cases
// depend on `ICartInventoryGatewayPort`, never on `@nestjs/microservices`. Both
// RPCs are sent through the `INVENTORY_MICROSERVICE` client so they land on
// `inventory_queue`, where the stock controller serves them.
@Injectable()
export class CartInventoryRabbitmqAdapter implements ICartInventoryGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

  // Both RPCs preserve the upstream typed error verbatim via the shared
  // `sendPreservingRpcError` (e.g. an `INVENTORY_OUT_OF_STOCK` 409 with
  // `details.available`) — the retail RPC filter only catches `CartDomainException`,
  // so the `RpcException` it wraps passes straight through to the gateway.
  public async reserveStock(payload: IReservationReservePayload): Promise<ReservationView> {
    return sendPreservingRpcError<ReservationView, IReservationReservePayload>(
      this.inventoryClient,
      ROUTING_KEYS.INVENTORY_RESERVATION_RESERVE,
      payload,
    );
  }

  public async releaseStock(
    payload: IReservationReleasePayload,
  ): Promise<IReservationReleaseResult> {
    return sendPreservingRpcError<IReservationReleaseResult, IReservationReleasePayload>(
      this.inventoryClient,
      ROUTING_KEYS.INVENTORY_RESERVATION_RELEASE,
      payload,
    );
  }
}
