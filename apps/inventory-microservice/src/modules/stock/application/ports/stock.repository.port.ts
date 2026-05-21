// TODO: introduce an `ITransactionPort` so callers can pass an opaque
// unit-of-work token instead of TypeORM's EntityManager. Tracked as
// ARCH-LINT-EX-01 in docs/adr/017-architecture-lint-via-eslint-boundaries.md §6.
import { EntityManager } from 'typeorm'; // eslint-disable-line boundaries/dependencies

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
