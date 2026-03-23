import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { IProductStockGet, ProductStockDto } from '@retail-inventory-system/inventory';

@Injectable()
export class ProductStockGetService {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryMicroserviceClient: ClientProxy,
  ) {}

  public async execute(productId: number, storageIds?: string[]): Promise<ProductStockDto> {
    const data: IProductStockGet = { productId, storageIds };

    return await firstValueFrom(
      this.inventoryMicroserviceClient.send<ProductStockDto, IProductStockGet>(
        MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET,
        data,
      ),
    );
  }
}
