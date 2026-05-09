// Central registry of cache-key templates. Migrated from
// `libs/common/cache/cache.helper.ts`; existing keys must continue to resolve
// identically so production cache entries remain valid across the deploy.
//
// Audit comments from the source `CacheHelper` are preserved verbatim — task-11
// re-evaluates the open items.
export const CACHE_KEYS = {
  // Cache values are typed at compile time only. If ProductStockGetResponseDto's
  // shape changes, in-flight cache entries from the old shape will deserialize
  // without runtime validation and may surface as silently-wrong responses for
  // one TTL window. Mitigation: include a schema version segment in the key
  // (e.g. `stock:v2:<productId>:...`) and bump it on breaking shape changes.
  // Not applied today; recorded for a future pass.
  // AUDIT-2026-05-08 [CACHE-003]
  productStockPrefix: (productId: number): string => `stock:${productId}:`,

  productStock: (productId: number, storageIds?: string[]): string => {
    const prefix = CACHE_KEYS.productStockPrefix(productId);
    // Cache key sort bug: the sort comparator uses only the FIRST
    // character's char code (`a.charCodeAt(0) - b.charCodeAt(0)`). For
    // any pair of storage IDs sharing a first character (e.g. `["ab",
    // "aa"]`) the comparator returns 0, so the resulting order depends
    // on the input order — and the cache key ends up input-order-
    // dependent too. The consequence is extra cache misses (not wrong
    // data), because callers that pass the same set of storage IDs in
    // different orders generate different keys. To fix, use a full
    // lexicographic compare: `a.localeCompare(b)`. Left unfixed by
    // request.
    // AUDIT-2026-05-08 [CACHE-010]
    //
    // The literal '*' "all-storages" sentinel below mimics a glob
    // pattern. SCAN MATCH handles it correctly today, but a future
    // refactor that calls cache.del('stock:<id>:*') would silently miss
    // this key. Replace with a non-meta sentinel such as '__all__'.
    // AUDIT-2026-05-08 [CACHE-011]
    const storageKey = storageIds
      ? [...storageIds].sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0)).join(',')
      : '*';

    return `${prefix}${storageKey}`;
  },
} as const;

// Backwards-compatible re-export — task-08 will migrate the inventory façade
// off `CacheHelper` onto the cache port directly. Until then keep the old
// shape so consumers can switch import paths without rewriting call sites.
//
// Tenant collision risk: cache keys are namespaced only by productId.
// There is no tenant/store segment, so once a multi-tenant model is
// introduced two tenants holding the same productId will read each
// other's cached stock — a correctness and data-leak bug. To fix,
// prepend the tenant identifier (e.g. `t:<tenantId>:stock:<productId>:`).
// No tenant model exists today, so this is latent. Left unfixed by request.
// AUDIT-2026-05-08 [CACHE-009]
export class CacheHelper {
  public static keyPrefixes = {
    productStock: CACHE_KEYS.productStockPrefix,
  };

  public static keys = {
    productStock: CACHE_KEYS.productStock,
  };
}
