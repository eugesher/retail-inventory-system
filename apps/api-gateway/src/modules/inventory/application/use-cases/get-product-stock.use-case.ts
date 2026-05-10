import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { ProductStockGetQueryDto } from '../../presentation/dto';
import { IInventoryGatewayPort, INVENTORY_GATEWAY_PORT } from '../ports';

@Injectable()
export class GetProductStockUseCase {
  constructor(
    @Inject(INVENTORY_GATEWAY_PORT)
    private readonly inventoryGateway: IInventoryGatewayPort,
    @InjectPinoLogger(GetProductStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    productId: number,
    dto: ProductStockGetQueryDto,
    correlationId: string,
  ): Promise<ProductStockGetResponseDto> {
    const { storageIds } = dto;

    this.logger.assign({ correlationId });

    try {
      this.logger.info({ productId, storageIds }, 'Retrieving product stock data');

      const productStock = await this.inventoryGateway.getProductStock(
        { productId, storageIds },
        correlationId,
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
