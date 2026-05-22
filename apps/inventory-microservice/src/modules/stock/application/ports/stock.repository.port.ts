import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

import { StockItem } from '../../domain';
import { ITransactionScope } from './transaction.port';

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

// `scope` on the read/write paths attaches the operation to an open
// unit-of-work — see ITransactionPort.
export interface IStockRepositoryPort {
  findById(id: number): Promise<StockItem | null>;
  findBySku(sku: string): Promise<StockItem | null>;
  aggregateForProduct(
    payload: IStockAggregateForProductPayload,
    scope?: ITransactionScope,
  ): Promise<ProductStockGetResponseDto>;
  lockedTotalsByProduct(
    payload: IStockLockedTotalsPayload,
    scope: ITransactionScope,
  ): Promise<Map<number, number>>;
  appendDeltas(payload: IStockAppendDeltasPayload, scope?: ITransactionScope): Promise<void>;
  save(stockItem: StockItem): Promise<StockItem>;
}
