import { EntityManager } from 'typeorm';

import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

import { StockItem } from '../../domain';

export const STOCK_REPOSITORY = Symbol('STOCK_REPOSITORY');

export interface IStockAggregateForProductPayload {
  productId: number;
  storageIds?: string[];
  correlationId?: string;
}

export interface IStockAppendDeltaItem {
  productId: number;
  storageId: string;
  actionId: string;
  quantity: number;
  orderProductId?: number;
}

export interface IStockAppendDeltasPayload {
  items: IStockAppendDeltaItem[];
  correlationId?: string;
}

export interface IStockLockedTotalsPayload {
  productIds: number[];
  correlationId?: string;
}

// Inbound port for the stock aggregate's persistence. Adapter is the
// TypeORM-backed `StockTypeormRepository`; use cases never reference the
// concrete repo or the `product_stock` entity directly. The optional
// `entityManager` arg on the write paths is the seam transactional callers
// use to attach the operation to an existing TypeORM unit-of-work.
export interface IStockRepositoryPort {
  findById(id: number): Promise<StockItem | null>;
  findBySku(sku: string): Promise<StockItem | null>;
  aggregateForProduct(
    payload: IStockAggregateForProductPayload,
    entityManager?: EntityManager,
  ): Promise<ProductStockGetResponseDto>;
  lockedTotalsByProduct(
    payload: IStockLockedTotalsPayload,
    entityManager: EntityManager,
  ): Promise<Map<number, number>>;
  appendDeltas(payload: IStockAppendDeltasPayload, entityManager?: EntityManager): Promise<void>;
  save(stockItem: StockItem): Promise<StockItem>;
}
