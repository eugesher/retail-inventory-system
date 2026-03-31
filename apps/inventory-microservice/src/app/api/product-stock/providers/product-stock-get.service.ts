import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import {
  IProductStockGetPayload,
  ProductStockGetResponseDto,
} from '@retail-inventory-system/inventory';
import { ProductStock } from '../../../common/entities';
import { IProductStockGetRawResult } from '../interfaces';

@Injectable()
export class ProductStockGetService {
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
    @InjectPinoLogger(ProductStockGetService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(data: IProductStockGetPayload): Promise<ProductStockGetResponseDto> {
    const { productId, storageIds, correlationId } = data;

    try {
      this.logger.info({ correlationId, productId, storageIds }, 'Received RPC: get product stock');

      const builder = this.productStockRepository
        .createQueryBuilder('ProductStock')
        .select([
          'ProductStock.storageId      AS storageId',
          'SUM(ProductStock.quantity)  AS quantity',
          'MAX(ProductStock.createdAt) AS updatedAt',
        ])
        .where('ProductStock.productId = :productId', { productId })
        .groupBy('storageId');

      if (storageIds && storageIds.length > 0) {
        builder.andWhere('ProductStock.storageId IN (:...storageIds)', { storageIds });
      }

      const stock = await builder.getRawMany<IProductStockGetRawResult>();

      this.logger.debug(
        { correlationId, productId, rowCount: stock.length },
        'Stock rows retrieved from DB',
      );

      let totalQuantity = 0;
      let latestDate = new Date(0);

      const items = stock.map((item) => {
        const quantity = Number(item.quantity);
        totalQuantity += quantity;
        if (item.updatedAt > latestDate) latestDate = item.updatedAt;
        return { storageId: item.storageId, quantity, updatedAt: item.updatedAt };
      });
      const updatedAt = stock.length > 0 ? latestDate : null;

      this.logger.info(
        { correlationId, productId, quantity: totalQuantity },
        'Product stock retrieved',
      );

      return { productId, quantity: totalQuantity, updatedAt, items };
    } catch (error) {
      this.logger.error(error, 'Error retrieving product stock');
      throw error;
    }
  }
}
