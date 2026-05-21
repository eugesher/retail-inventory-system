import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IOrderProductConfirm,
  IProductStockOrderConfirmPayload,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IInventoryConfirmGatewayPort } from '../../application/ports';

@Injectable()
export class InventoryConfirmRabbitmqAdapter implements IInventoryConfirmGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryClient: ClientProxy,
  ) {}

  // The TypeScript compile is the cross-service contract test — the
  // inventory-side handler imports `IProductStockOrderConfirmPayload` from
  // the same place (ADR-013 §7).
  public async reserveOrderStock(payload: {
    products: IOrderProductConfirm[];
    correlationId: string;
  }): Promise<number[]> {
    return firstValueFrom(
      this.inventoryClient.send<number[], IProductStockOrderConfirmPayload>(
        ROUTING_KEYS.INVENTORY_ORDER_CONFIRM,
        { products: payload.products, correlationId: payload.correlationId },
      ),
    );
  }
}
