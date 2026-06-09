import { VariantStockView } from '@retail-inventory-system/contracts';

export const STOCK_CACHE = Symbol('STOCK_CACHE');

export interface IStockCacheGetPayload {
  variantId: number;
  stockLocationIds?: string[];
  // ADR-022 opt-in tenant segment; absent today. CACHE-009 tracks the latent
  // multi-tenant migration this surface unblocks.
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
export interface IStockCachePort {
  get(payload: IStockCacheGetPayload): Promise<IStockCacheGetResult>;
  set(payload: IStockCacheSetPayload): Promise<void>;
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
