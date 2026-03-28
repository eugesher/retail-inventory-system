import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { IProductStockGetPayload, ProductStockDto } from '@retail-inventory-system/inventory';
import { ProductStockGetDto } from '../dto';

@Injectable()
export class ProductStockGetService {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryMicroserviceClient: ClientProxy,
  ) {}

  public async execute(
    productId: number,
    dto: ProductStockGetDto,
    correlationId: string,
  ): Promise<ProductStockDto> {
    const { storageIds } = dto;
    const data: IProductStockGetPayload = { productId, storageIds, correlationId };

    return await firstValueFrom(
      this.inventoryMicroserviceClient.send<ProductStockDto, IProductStockGetPayload>(
        MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET,
        data,
      ),
    );
  }
}
