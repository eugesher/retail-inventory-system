import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IReservationReleasePayload,
  IReservationReleaseResult,
  IReservationReservePayload,
  ReservationView,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

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

  public async reserveStock(payload: IReservationReservePayload): Promise<ReservationView> {
    return this.send<ReservationView, IReservationReservePayload>(
      ROUTING_KEYS.INVENTORY_RESERVATION_RESERVE,
      payload,
    );
  }

  public async releaseStock(
    payload: IReservationReleasePayload,
  ): Promise<IReservationReleaseResult> {
    return this.send<IReservationReleaseResult, IReservationReleasePayload>(
      ROUTING_KEYS.INVENTORY_RESERVATION_RELEASE,
      payload,
    );
  }

  // The shared send + error-passthrough rule. `firstValueFrom` materializes the
  // cold `send()` Observable; on rejection the inventory RPC filter has already
  // shaped the wire error as `{ statusCode, message, code, details? }` (e.g.
  // `INVENTORY_OUT_OF_STOCK` with `details.available`). We rethrow it wrapped in
  // `RpcException(err)` so that exact object reaches the gateway's `throwRpcError`
  // verbatim — an uncaught plain-object rejection would be re-wrapped lossily by
  // Nest's transport layer (the typed `code` + `details` would be dropped). The
  // retail RPC filter only catches `CartDomainException`, so this `RpcException`
  // passes straight through the retail handler and is serialized back unchanged.
  private async send<TResult, TPayload>(routingKey: string, payload: TPayload): Promise<TResult> {
    try {
      return await firstValueFrom(
        this.inventoryClient.send<TResult, TPayload>(routingKey, payload),
      );
    } catch (err) {
      throw new RpcException(err as object);
    }
  }
}
