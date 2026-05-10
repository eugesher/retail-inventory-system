import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  IProductStockGetPayload,
  ProductStockGetResponseDto,
} from '@retail-inventory-system/contracts';
import { MicroserviceClientTokenEnum, ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { IGetProductStockQuery, IInventoryGatewayPort } from '../../application/ports';

@Injectable()
export class InventoryRabbitmqAdapter implements IInventoryGatewayPort {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly client: ClientProxy,
  ) {}

  public async getProductStock(
    query: IGetProductStockQuery,
    correlationId: string,
  ): Promise<ProductStockGetResponseDto> {
    return firstValueFrom(
      this.client.send<ProductStockGetResponseDto, IProductStockGetPayload>(
        ROUTING_KEYS.INVENTORY_PRODUCT_STOCK_GET,
        { ...query, correlationId },
      ),
    );
  }
}
