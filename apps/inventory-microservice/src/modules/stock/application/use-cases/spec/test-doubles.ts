import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

import { StockItem, StockLowEvent, StockReservedEvent } from '../../../domain';
import {
  IStockAggregateForProductPayload,
  IStockAppendDeltasPayload,
  IStockCacheGetPayload,
  IStockCacheGetResult,
  IStockCacheInvalidateItem,
  IStockCachePort,
  IStockCacheSetPayload,
  IStockEventsPublisherPort,
  IStockLockedTotalsPayload,
  IStockRepositoryPort,
  IStockWithInvalidationOptions,
  ITransactionScope,
} from '../../ports';

// In-memory stock repository implementation. Stores StockItem aggregates by
// (productId, storageId). Pure TypeScript — no jest globals here so the file
// is safe to include in production builds when not excluded by tsconfig.app.
export class InMemoryStockRepository implements IStockRepositoryPort {
  public readonly items = new Map<string, StockItem>();
  public readonly deltas: IStockAppendDeltasPayload['items'] = [];

  private key(productId: number, storageId: string): string {
    return `${productId}:${storageId}`;
  }

  public seed(stockItem: StockItem): void {
    this.items.set(this.key(stockItem.productId, stockItem.storageId), stockItem);
  }

  public findById(id: number): Promise<StockItem | null> {
    void id;
    return Promise.resolve(null);
  }

  public findBySku(sku: string): Promise<StockItem | null> {
    void sku;
    return Promise.resolve(null);
  }

  public aggregateForProduct(
    payload: IStockAggregateForProductPayload,
    scope?: ITransactionScope,
  ): Promise<ProductStockGetResponseDto> {
    void scope;
    const matching = [...this.items.values()].filter(
      (item) =>
        item.productId === payload.productId &&
        (!payload.storageIds ||
          payload.storageIds.length === 0 ||
          payload.storageIds.includes(item.storageId)),
    );
    const items = matching.map((item) => ({
      storageId: item.storageId,
      quantity: item.quantity,
      updatedAt: item.updatedAt ?? new Date(0),
    }));
    const quantity = items.reduce((sum, i) => sum + i.quantity, 0);
    const updatedAt = items.length > 0 ? new Date(0) : null;
    return Promise.resolve({ productId: payload.productId, quantity, updatedAt, items });
  }

  public lockedTotalsByProduct(
    payload: IStockLockedTotalsPayload,
    scope: ITransactionScope,
  ): Promise<Map<number, number>> {
    void scope;
    const totals = new Map<number, number>();
    for (const item of this.items.values()) {
      if (!payload.productIds.includes(item.productId)) continue;
      totals.set(item.productId, (totals.get(item.productId) ?? 0) + item.quantity);
    }
    return Promise.resolve(totals);
  }

  public appendDeltas(
    payload: IStockAppendDeltasPayload,
    scope?: ITransactionScope,
  ): Promise<void> {
    void scope;
    for (const item of payload.items) {
      this.deltas.push(item);
      const key = this.key(item.productId, item.storageId);
      const current = this.items.get(key);
      if (current) {
        const next = new StockItem({
          productId: current.productId,
          storageId: current.storageId,
          quantity: Math.max(0, current.quantity + item.quantity),
        });
        this.items.set(key, next);
      }
    }
    return Promise.resolve();
  }

  public save(stockItem: StockItem): Promise<StockItem> {
    this.seed(stockItem);
    return Promise.resolve(stockItem);
  }
}

// In-memory cache port implementation. Stores set values verbatim and
// records every invalidation/set call so specs can assert on them.
export class InMemoryStockCache implements IStockCachePort {
  public readonly store = new Map<string, ProductStockGetResponseDto>();
  public readonly invalidations: {
    items: IStockCacheInvalidateItem[];
    opts?: IStockWithInvalidationOptions;
  }[] = [];
  public readonly setCalls: IStockCacheSetPayload[] = [];

  private key(productId: number, storageIds?: string[]): string {
    return `${productId}:${(storageIds ?? []).slice().sort().join(',') || '*'}`;
  }

  public get(payload: IStockCacheGetPayload): Promise<IStockCacheGetResult> {
    const value = this.store.get(this.key(payload.productId, payload.storageIds));
    return Promise.resolve({ value, available: true });
  }

  public set(payload: IStockCacheSetPayload): Promise<void> {
    this.store.set(this.key(payload.productId, payload.storageIds), payload.data);
    this.setCalls.push(payload);
    return Promise.resolve();
  }

  public async getOrLoad(
    payload: IStockCacheGetPayload,
    loader: () => Promise<ProductStockGetResponseDto>,
  ): Promise<ProductStockGetResponseDto> {
    const { value, available } = await this.get(payload);
    if (value !== undefined) return value;
    const data = await loader();
    if (available) {
      await this.set({
        productId: payload.productId,
        storageIds: payload.storageIds,
        data,
        correlationId: payload.correlationId,
      });
    }
    return data;
  }

  public async withInvalidation<T>(
    work: () => Promise<T>,
    resolveItems: (result: T) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<T> {
    const result = await work();
    const items = resolveItems(result);
    if (items.length > 0) {
      this.invalidations.push({ items, opts });
    }
    return result;
  }
}

// In-memory publisher; records every emit so specs can assert on event
// payloads without binding to RxJS.
export class InMemoryStockEventsPublisher implements IStockEventsPublisherPort {
  public readonly lows: { event: StockLowEvent; correlationId?: string }[] = [];
  public readonly reserves: { event: StockReservedEvent; correlationId?: string }[] = [];

  public publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void> {
    this.lows.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockReserved(event: StockReservedEvent, correlationId?: string): Promise<void> {
    this.reserves.push({ event, correlationId });
    return Promise.resolve();
  }
}
