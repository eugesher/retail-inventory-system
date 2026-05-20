import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

export const STOCK_CACHE = Symbol('STOCK_CACHE');

export interface IStockCacheGetPayload {
  productId: number;
  storageIds?: string[];
  // Optional per ADR-022: when supplied, the resulting cache key carries a
  // `t:<tenantId>` segment so two tenants holding the same productId never
  // read each other's cached stock. Absent today (no tenant model in the
  // domain yet) but the port surface accepts it so a future migration to
  // multi-tenant is a wiring change, not a contract change.
  tenantId?: string;
  correlationId?: string;
}

export interface IStockCacheSetPayload {
  productId: number;
  storageIds?: string[];
  // See `IStockCacheGetPayload.tenantId`. Writes that target a tenanted
  // key must carry the same `tenantId` as the read that produced the miss.
  tenantId?: string;
  data: ProductStockGetResponseDto;
  correlationId?: string;
}

export interface IStockCacheInvalidateItem {
  productId: number;
  storageId: string;
}

// Return shape of `IStockCachePort.get`. The `available` flag lets callers
// (notably `getOrLoad`) distinguish a clean miss (`{ value: undefined,
// available: true }`) from a Redis-down outage (`{ value: undefined,
// available: false }`) so the write-back path can be skipped on outage —
// preventing the duplicate `Failed to read from cache` + `Failed to write
// to cache` warn pair that otherwise lands per request during an outage
// (CACHE-005).
export interface IStockCacheGetResult {
  value: ProductStockGetResponseDto | undefined;
  available: boolean;
}

export interface IStockWithInvalidationOptions {
  // Per ADR-022 §"Tenant is opt-in": invalidating tenant A's cache must
  // not touch tenant B's keys. `tenantId` is opt-in (one tenant per call)
  // because every item in a given confirm RPC belongs to the same tenant.
  tenantId?: string;
  correlationId?: string;
}

// Stock-specific cache port. Sits on top of the generic CACHE_PORT
// (`libs/cache`) but knows the stock cache-key shape so use cases never
// touch raw key strings. The adapter preserves the ADR-002 cache-aside
// contract verbatim — SCAN+UNLINK on Redis, named-key fallback elsewhere.
// `getOrLoad` adds the ADR-021 single-flight + jitter guarantees on the
// miss path; `get`/`set` remain for callers that want explicit control.
//
// Per ADR-023 there is **no** public `invalidate(...)` method. Callers
// route every write-path invalidation through `withInvalidation`: the
// helper runs the supplied `work` callback first and only invokes the
// internal prefix delete *after* `work` resolves. This makes the
// post-commit ordering an intrinsic property of the type signature
// rather than a comment-enforced contract — calling the invalidation
// step from inside the transaction work is not expressible.
export interface IStockCachePort {
  get(payload: IStockCacheGetPayload): Promise<IStockCacheGetResult>;
  set(payload: IStockCacheSetPayload): Promise<void>;
  getOrLoad(
    payload: IStockCacheGetPayload,
    loader: () => Promise<ProductStockGetResponseDto>,
  ): Promise<ProductStockGetResponseDto>;
  // Runs `work` first; on resolution, derives invalidation items from the
  // result and wipes the matching cache prefixes. On rejection nothing is
  // invalidated and the rejection is rethrown. The `resolveItems` callback
  // receives the resolved `work` result so the use case can co-locate the
  // discovery (which (productId, storageId) pairs were mutated) and the
  // transactional write inside one closure.
  withInvalidation<T>(
    work: () => Promise<T>,
    resolveItems: (result: T) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<T>;
}
