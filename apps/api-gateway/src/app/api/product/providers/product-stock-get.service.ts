import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { firstValueFrom } from 'rxjs';

import {
  MicroserviceClientTokenEnum,
  MicroserviceMessagePatternEnum,
} from '@retail-inventory-system/common';
import { IProductStockGetPayload, ProductStockDto } from '@retail-inventory-system/inventory';
import { ProductStockGetDto } from '../dto';
import { throwRpcError } from '../../../common/rpc-error.util';

@Injectable()
export class ProductStockGetService {
  constructor(
    @Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE)
    private readonly inventoryMicroserviceClient: ClientProxy,
    @InjectPinoLogger(ProductStockGetService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    productId: number,
    dto: ProductStockGetDto,
    correlationId: string,
  ): Promise<ProductStockDto> {
    const { storageIds } = dto;

    this.logger.assign({ correlationId });

    try {
      this.logger.info({ productId, storageIds }, 'Retrieving product stock data');
      this.logger.info(
        { pattern: MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET },
        'Sending RPC to inventory service',
      );

      const productStock = await firstValueFrom(
        this.inventoryMicroserviceClient.send<ProductStockDto, IProductStockGetPayload>(
          MicroserviceMessagePatternEnum.INVENTORY_PRODUCT_STOCK_GET,
          { productId, storageIds, correlationId },
        ),
      );

      this.logger.info(
        { productId, quantity: productStock.quantity },
        'Product stock data retrieved',
      );

      return productStock;
    } catch (error) {
      this.logger.error(error, 'Error retrieving product stock data');

      throwRpcError(error);
    }
  }
}
