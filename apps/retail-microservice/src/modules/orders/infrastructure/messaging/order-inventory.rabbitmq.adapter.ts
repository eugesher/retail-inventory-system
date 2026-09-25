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

@Injectable()
export class OrderInventoryRabbitmqAdapter implements IOrderInventoryGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

  public async allocateStock(payload: IReservationAllocatePayload): Promise<IAllocationResult> {
    return sendPreservingRpcError<IAllocationResult, IReservationAllocatePayload>(
      this.inventoryClient,
      ROUTING_KEYS.INVENTORY_RESERVATION_ALLOCATE,
      payload,
    );
  }

  public async cancelAllocation(payload: IAllocationCancelPayload): Promise<void> {
    await sendPreservingRpcError<{ cancelled: number }, IAllocationCancelPayload>(
      this.inventoryClient,
      ROUTING_KEYS.INVENTORY_ALLOCATION_CANCEL,
      payload,
    );
  }
}
