import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IProductStockGetPayload,
  ProductStockGetResponseDto,
} from '@retail-inventory-system/inventory';
import { ProductStockCommonService } from '../../../common/modules';

@Injectable()
export class ProductStockGetService {
  constructor(
    private readonly productStockCommonService: ProductStockCommonService,
    @InjectPinoLogger(ProductStockGetService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IProductStockGetPayload): Promise<ProductStockGetResponseDto> {
    try {
      this.logger.info(payload, 'Received RPC: get product stock');

      return await this.productStockCommonService.get(payload);
    } catch (error) {
      this.logger.error({ ...payload, ...error }, 'Error retrieving product stock');

      throw error;
    }
  }
}
