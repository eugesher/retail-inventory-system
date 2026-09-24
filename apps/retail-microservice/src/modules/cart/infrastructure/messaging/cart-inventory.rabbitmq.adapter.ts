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

@Injectable()
export class CartInventoryRabbitmqAdapter implements ICartInventoryGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

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
