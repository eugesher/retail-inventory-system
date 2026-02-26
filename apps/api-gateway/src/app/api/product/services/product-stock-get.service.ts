import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientNameEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { IProductStockGet, ProductStockDto } from '@retail-inventory-system/inventory';

@Injectable()
export class ProductStockGetService {
  constructor(
    @Inject(MicroserviceClientNameEnum.INVENTORY_SERVICE)
    private readonly inventoryRmqClient: ClientProxy,
  ) {}

  public async execute(productId: string, storeIds?: string): Promise<ProductStockDto> {
    const data: IProductStockGet = { productId };

    if (storeIds) {
      data.storeIds = storeIds.split(',').map((s) => s.trim());
    }

    return await firstValueFrom(
      this.inventoryRmqClient.send<ProductStockDto, IProductStockGet>(
        MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET,
        data,
      ),
    );
  }
}
