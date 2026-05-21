import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, EntityManager, Repository } from 'typeorm';

import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';
import { BaseTypeormRepository } from '@retail-inventory-system/database';

import { StockItem } from '../../domain';
import {
  IStockAggregateForProductPayload,
  IStockAppendDeltasPayload,
  IStockLockedTotalsPayload,
  IStockRepositoryPort,
  ITransactionScope,
} from '../../application/ports';
import { ProductStock } from './product-stock.entity';
import { StockItemMapper } from './stock-item.mapper';

interface IProductStockRawResult {
  storageId: string;
  quantity: `${number}`;
  updatedAt: Date;
}

@Injectable()
export class StockTypeormRepository
  extends BaseTypeormRepository<ProductStock, StockItem>
  implements IStockRepositoryPort
{
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
    @InjectPinoLogger(StockTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {
    super(productStockRepository);
  }

  protected toDomain(entity: ProductStock): StockItem {
    return StockItemMapper.toDomain(entity);
  }

  protected toEntity(domain: StockItem): DeepPartial<ProductStock> {
    return {
      productId: domain.productId,
      storageId: domain.storageId,
      quantity: domain.quantity,
    };
  }

  // The repository adapter is the only place inside the stock module that
  // downcasts `ITransactionScope` to its concrete `EntityManager` form. The
  // application layer holds the scope as an opaque token; the type-erasure
  // here is the seam between the hexagonal abstraction and the ORM.
  private toEntityManager(scope: ITransactionScope | undefined): EntityManager | undefined {
    return scope as unknown as EntityManager | undefined;
  }

  public async findById(id: number): Promise<StockItem | null> {
    const entity = await this.productStockRepository.findOne({ where: { id } });
    return entity ? StockItemMapper.toDomain(entity) : null;
  }

  public findBySku(sku: string): Promise<StockItem | null> {
    // The current schema does not carry an SKU column on `product_stock`; the
    // port surface includes the lookup so future schema evolutions can light
    // it up without changing call-site code. Returning null today is
    // intentional, not a "not implemented" stub — callers must tolerate the
    // miss until the column exists.
    void sku;
    return Promise.resolve(null);
  }

  public async aggregateForProduct(
    payload: IStockAggregateForProductPayload,
    scope?: ITransactionScope,
  ): Promise<ProductStockGetResponseDto> {
    const { productId, storageIds, correlationId } = payload;
    const entityManager = this.toEntityManager(scope);
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

    let stock: IProductStockRawResult[];

    try {
      stock = await builder.getRawMany<IProductStockRawResult>();
    } catch (error) {
      this.logger.error(
        { err: error as Error, correlationId, productId, storageIds },
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

  public async lockedTotalsByProduct(
    payload: IStockLockedTotalsPayload,
    scope: ITransactionScope,
  ): Promise<Map<number, number>> {
    const { productIds, correlationId } = payload;

    if (productIds.length === 0) {
      return new Map();
    }

    const entityManager = this.toEntityManager(scope)!;
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
        { err: error as Error, correlationId, productIds },
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

  public async appendDeltas(
    payload: IStockAppendDeltasPayload,
    scope?: ITransactionScope,
  ): Promise<void> {
    const { items, correlationId } = payload;
    const itemCount = items.length;
    const entityManager = this.toEntityManager(scope);

    this.logger.debug(
      { correlationId, itemCount, withinTransaction: !!entityManager },
      'Inserting product stock ledger rows',
    );

    const repository = entityManager
      ? entityManager.getRepository(ProductStock)
      : this.productStockRepository;

    try {
      await repository.insert(items);
    } catch (error) {
      this.logger.error(
        { err: error as Error, correlationId, itemCount },
        'Failed to insert product stock ledger rows',
      );

      throw error;
    }

    this.logger.info(
      {
        correlationId,
        itemCount,
        productIds: [...new Set(items.map((i) => i.productId))],
      },
      'Product stock ledger rows inserted',
    );
  }

  public async save(stockItem: StockItem): Promise<StockItem> {
    const partial = this.toEntity(stockItem);
    const saved = await this.productStockRepository.save(partial);
    return StockItemMapper.toDomain(saved as ProductStock);
  }
}
