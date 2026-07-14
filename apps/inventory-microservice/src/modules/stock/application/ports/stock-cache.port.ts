import { VariantStockView } from '@retail-inventory-system/contracts';

export const STOCK_CACHE = Symbol('STOCK_CACHE');

export interface IStockCacheGetPayload {
  variantId: number;
  stockLocationIds?: string[];
  // The ADR-022 tenant segment. **Opt-in, and nothing supplies it** — a key with no `tenantId`
  // omits the segment entirely rather than defaulting it, so single-tenant keys carry no
  // tenant-shaped lie. The parameter exists so a multi-tenant read path would not have to re-key.
  tenantId?: string;
  correlationId?: string;
}

export interface IStockCacheSetPayload {
  variantId: number;
  stockLocationIds?: string[];
  // Writes must carry the same `tenantId` as the read that produced the miss.
  tenantId?: string;
  data: VariantStockView;
  correlationId?: string;
}

export interface IStockCacheInvalidateItem {
  variantId: number;
  stockLocationId: string;
}

// CACHE-005: `available: false` distinguishes a Redis-down read from a
// clean miss so `getOrLoad` can skip the write-back instead of doubling
// the per-request warn count.
export interface IStockCacheGetResult {
  value: VariantStockView | undefined;
  available: boolean;
}

export interface IStockWithInvalidationOptions {
  // One tenant per call (ADR-022): every item in a write RPC belongs to
  // the same tenant, so tenant A's invalidate must not touch tenant B.
  tenantId?: string;
  correlationId?: string;
}

// ADR-023: no public `invalidate(...)`. `withInvalidation` runs `work`
// first and only then fires the internal prefix delete, so the post-commit
// ordering is type-enforced — invalidating from inside a transaction
// callback is not expressible.
//
// ADR-049 closes the gap that left: `get` / `set` were on this port too, called by
// nothing but the adapter's own `getOrLoad`. A public `set` is a way around the same
// guarantee — pre-commit data written straight into the key is as permanently stale as
// a pre-commit invalidate — so they are private to the adapter now. The port offers the
// two composed operations and no raw access to the key.
export interface IStockCachePort {
  getOrLoad(
    payload: IStockCacheGetPayload,
    loader: () => Promise<VariantStockView>,
  ): Promise<VariantStockView>;
  // `resolveItems` receives the resolved `work` result so the write use case
  // can co-locate the discovery of mutated (variantId, stockLocationId) pairs
  // with the transactional write inside one closure (consumed by the later
  // Receive/Adjust capability).
  withInvalidation<T>(
    work: () => Promise<T>,
    resolveItems: (result: T) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ): Promise<T>;
}
