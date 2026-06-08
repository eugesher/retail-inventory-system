import { VariantStockView } from '@retail-inventory-system/contracts';

import { StockLevel, StockLocation } from '../../../domain';
import {
  IStockCacheGetPayload,
  IStockCacheGetResult,
  IStockCacheInvalidateItem,
  IStockCachePort,
  IStockCacheSetPayload,
  IStockRepositoryPort,
  IStockWithInvalidationOptions,
} from '../../ports';

// In-memory `IStockRepositoryPort` over two maps — stock levels keyed on
// `(variantId, stockLocationId)` and locations keyed on the string id. Domain
// types only, mirroring the real repository's port contract.
export class InMemoryStockRepository implements IStockRepositoryPort {
  public readonly levels = new Map<string, StockLevel>();
  public readonly locations = new Map<string, StockLocation>();

  private key(variantId: number, stockLocationId: string): string {
    return `${variantId}:${stockLocationId}`;
  }

  public seedLevel(level: StockLevel): void {
    this.levels.set(this.key(level.variantId, level.stockLocationId), level);
  }

  public seedLocation(location: StockLocation): void {
    this.locations.set(location.id, location);
  }

  public findLocation(id: string): Promise<StockLocation | null> {
    return Promise.resolve(this.locations.get(id) ?? null);
  }

  public listLocations(activeOnly = false): Promise<StockLocation[]> {
    const all = [...this.locations.values()];
    return Promise.resolve(activeOnly ? all.filter((location) => location.active) : all);
  }

  public findStockLevel(variantId: number, stockLocationId: string): Promise<StockLevel | null> {
    return Promise.resolve(this.levels.get(this.key(variantId, stockLocationId)) ?? null);
  }

  public findStockLevelsByVariant(
    variantId: number,
    stockLocationIds?: string[],
  ): Promise<StockLevel[]> {
    const matching = [...this.levels.values()].filter(
      (level) =>
        level.variantId === variantId &&
        (!stockLocationIds ||
          stockLocationIds.length === 0 ||
          stockLocationIds.includes(level.stockLocationId)),
    );
    return Promise.resolve(matching);
  }

  public saveStockLevel(stockLevel: StockLevel): Promise<StockLevel> {
    this.seedLevel(stockLevel);
    return Promise.resolve(stockLevel);
  }
}

// In-memory `IStockCachePort` mirroring the real adapter's cache-aside +
// invalidation contract (ADR-021 / ADR-023) without Redis. `available = false`
// simulates a Redis-down read so the use case's fallback path can be exercised
// (CACHE-005).
export class InMemoryStockCache implements IStockCachePort {
  public readonly store = new Map<string, VariantStockView>();
  public readonly setCalls: IStockCacheSetPayload[] = [];
  public readonly invalidations: {
    items: IStockCacheInvalidateItem[];
    opts?: IStockWithInvalidationOptions;
  }[] = [];
  public available = true;

  private key(variantId: number, stockLocationIds?: string[]): string {
    const facet =
      stockLocationIds && stockLocationIds.length > 0
        ? [...stockLocationIds].sort((a, b) => a.localeCompare(b)).join(',')
        : '__all__';
    return `${variantId}:${facet}`;
  }

  public seed(variantId: number, data: VariantStockView, stockLocationIds?: string[]): void {
    this.store.set(this.key(variantId, stockLocationIds), data);
  }

  public get(payload: IStockCacheGetPayload): Promise<IStockCacheGetResult> {
    if (!this.available) {
      return Promise.resolve({ value: undefined, available: false });
    }
    const value = this.store.get(this.key(payload.variantId, payload.stockLocationIds));
    return Promise.resolve({ value, available: true });
  }

  public set(payload: IStockCacheSetPayload): Promise<void> {
    this.store.set(this.key(payload.variantId, payload.stockLocationIds), payload.data);
    this.setCalls.push(payload);
    return Promise.resolve();
  }

  public async getOrLoad(
    payload: IStockCacheGetPayload,
    loader: () => Promise<VariantStockView>,
  ): Promise<VariantStockView> {
    const { value, available } = await this.get(payload);
    if (value !== undefined) return value;
    const data = await loader();
    if (available) {
      await this.set({
        variantId: payload.variantId,
        stockLocationIds: payload.stockLocationIds,
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
