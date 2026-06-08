import { VariantStockView } from '@retail-inventory-system/contracts';

import {
  StockAdjustedEvent,
  StockLevel,
  StockLevelInitializedEvent,
  StockLocation,
  StockLowEvent,
  StockReceivedEvent,
  StockReservedEvent,
} from '../../../domain';
import {
  IStockCacheGetPayload,
  IStockCacheGetResult,
  IStockCacheInvalidateItem,
  IStockCachePort,
  IStockCacheSetPayload,
  IStockEventsPublisherPort,
  IStockRepositoryPort,
  ITransactionPort,
  ITransactionScope,
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

// Runs the transactional `work` immediately with an opaque sentinel scope — the
// real adapter opens a MySQL transaction, but the use cases never touch the scope
// directly (the repository owns persistence), so a pass-through double is faithful
// to the contract the write use cases depend on.
export class ImmediateTransactionPort implements ITransactionPort {
  public calls = 0;

  public runInTransaction<T>(work: (scope: ITransactionScope) => Promise<T>): Promise<T> {
    this.calls += 1;
    return work({} as unknown as ITransactionScope);
  }
}

// Records every publish so the write-use-case specs can assert which events fired
// (and, for low-stock, that it fires only at/below the threshold). All methods
// resolve — the post-commit emit is best-effort (ADR-020).
export class RecordingStockEventsPublisher implements IStockEventsPublisherPort {
  public readonly low: { event: StockLowEvent; correlationId?: string }[] = [];
  public readonly received: { event: StockReceivedEvent; correlationId?: string }[] = [];
  public readonly adjusted: { event: StockAdjustedEvent; correlationId?: string }[] = [];
  public readonly reserved: { event: StockReservedEvent; correlationId?: string }[] = [];
  public readonly initialized: { event: StockLevelInitializedEvent; correlationId?: string }[] = [];

  public publishStockLow(event: StockLowEvent, correlationId?: string): Promise<void> {
    this.low.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockReserved(event: StockReservedEvent, correlationId?: string): Promise<void> {
    this.reserved.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockReceived(event: StockReceivedEvent, correlationId?: string): Promise<void> {
    this.received.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockAdjusted(event: StockAdjustedEvent, correlationId?: string): Promise<void> {
    this.adjusted.push({ event, correlationId });
    return Promise.resolve();
  }

  public publishStockLevelInitialized(
    event: StockLevelInitializedEvent,
    correlationId?: string,
  ): Promise<void> {
    this.initialized.push({ event, correlationId });
    return Promise.resolve();
  }
}

// A silent `PinoLogger` so specs assert behaviour, not log output. Uses plain
// no-op functions (not `jest.fn()`) so this shared helper stays compilable by the
// production webpack build, which includes non-`.spec.ts` files.
export const silentLogger = (): import('nestjs-pino').PinoLogger => {
  const noop = (): void => undefined;
  return {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
    assign: noop,
  } as unknown as import('nestjs-pino').PinoLogger;
};
