import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import { ProductStockGetResponseDto } from '@retail-inventory-system/inventory';
import { ProductStock } from '../../../entities';
import {
  IProductStockCommonGet,
  IProductStockCommonGetRawResult,
  IProductStockCommonMapGetLocked,
} from '../interfaces';

@Injectable()
export class ProductStockCommonGetService {
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
    @InjectPinoLogger(ProductStockCommonGetService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: IProductStockCommonGet,
    entityManager?: EntityManager,
  ): Promise<ProductStockGetResponseDto> {
    const { productId, storageIds, correlationId } = payload;
    const repository = entityManager
      ? entityManager.getRepository(ProductStock)
      : this.productStockRepository;

    const builder = repository
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

    let stock: IProductStockCommonGetRawResult[];

    try {
      stock = await builder.getRawMany<IProductStockCommonGetRawResult>();
    } catch (error) {
      this.logger.error(
        { ...error, correlationId, productId, storageIds },
        'Failed to aggregate product stock by storage',
      );

      throw error;
    }

    this.logger.debug(
      { correlationId, productId, rowCount: stock.length },
      'Stock rows retrieved from DB',
    );

    let quantity = 0;
    let latestDate = new Date(0);

    const items = stock.map((item) => {
      const itemQuantity = Number(item.quantity);

      quantity += itemQuantity;

      if (item.updatedAt > latestDate) {
        latestDate = item.updatedAt;
      }

      return { storageId: item.storageId, quantity: itemQuantity, updatedAt: item.updatedAt };
    });
    const updatedAt = stock.length > 0 ? latestDate : null;

    return { productId, quantity, updatedAt, items };
  }

  public async getMapLocked(
    payload: IProductStockCommonMapGetLocked,
    entityManager: EntityManager,
  ): Promise<Map<number, number>> {
    const { productIds, correlationId } = payload;

    if (productIds.length === 0) {
      return new Map();
    }

    let rows: { productId: string; totalQuantity: string }[];

    try {
      rows = await entityManager
        .createQueryBuilder(ProductStock, 'ps')
        .select('ps.productId', 'productId')
        .addSelect('SUM(ps.quantity)', 'totalQuantity')
        .where('ps.productId IN (:...productIds)', { productIds })
        .groupBy('ps.productId')
        .setLock('pessimistic_write')
        .getRawMany();
    } catch (error) {
      this.logger.error(
        { ...error, correlationId, productIds },
        'Failed to load locked stock totals',
      );

      throw error;
    }

    this.logger.debug(
      { correlationId, productIds, balanceCount: rows.length },
      'Locked stock totals loaded from DB',
    );

    return new Map(
      rows.map(({ productId, totalQuantity }) => [Number(productId), Number(totalQuantity)]),
    );
  }
}
