// Central registry of cache-key templates. Every cache key in `apps/*/src`
// must come from this file — no string literals. Two key families coexist:
//
//   * **New convention** (introduced in task-11 / ADR-016):
//     `ris:<service>:<aggregate>:<id>[:<facet>]`. Examples:
//       - `ris:inventory:stock:42:__all__`
//       - `ris:inventory:stock:42:head-warehouse`
//       - `ris:inventory:stock:42:head-warehouse,west-warehouse`
//       - `ris:retail:order:7`
//
//   * **Legacy convention** (predates ADR-016):
//     `stock:<productId>:[*|<storageIds>]`. Kept as builders so the cache
//     invalidation path can wipe in-flight entries written under the old
//     prefix during the deploy.
//
// Two audit findings from `docs/audits/audit-2026-05-08.md` are resolved
// by the new builder:
//   * `CACHE-010` — full lexicographic compare via `localeCompare` (the
//     legacy comparator used `charCodeAt(0)` only).
//   * `CACHE-011` — non-glob `__all__` sentinel for the "every storage"
//     key (the legacy sentinel was the literal `*`).
//
// `CACHE-003` (schema-version segment) and `CACHE-009` (tenant segment)
// are still open — both would require a coordinated bump and a tenant
// model that does not exist today.
export const CACHE_KEYS = {
  // -- New convention -------------------------------------------------------
  inventoryStockPrefix: (productId: number): string => `ris:inventory:stock:${productId}:`,

  inventoryStock: (productId: number, storageIds?: string[]): string => {
    const prefix = CACHE_KEYS.inventoryStockPrefix(productId);
    const facet =
      storageIds && storageIds.length > 0
        ? [...storageIds].sort((a, b) => a.localeCompare(b)).join(',')
        : '__all__';
    return `${prefix}${facet}`;
  },

  retailOrderPrefix: (orderId: number): string => `ris:retail:order:${orderId}`,
  retailOrder: (orderId: number): string => CACHE_KEYS.retailOrderPrefix(orderId),

  // -- Legacy convention ----------------------------------------------------
  // Retained so the SCAN-based invalidate path can wipe entries written
  // under the previous prefix during a single rolling deploy. New writes
  // always use the `inventoryStock*` builders above.
  productStockPrefix: (productId: number): string => `stock:${productId}:`,

  productStock: (productId: number, storageIds?: string[]): string => {
    const prefix = CACHE_KEYS.productStockPrefix(productId);
    const storageKey =
      storageIds && storageIds.length > 0
        ? [...storageIds].sort((a, b) => a.charCodeAt(0) - b.charCodeAt(0)).join(',')
        : '*';
    return `${prefix}${storageKey}`;
  },
} as const;

// Backwards-compat alias kept for the one release that still imports it.
// Removed in task-14.
export class CacheHelper {
  public static keyPrefixes = {
    productStock: CACHE_KEYS.productStockPrefix,
  };

  public static keys = {
    productStock: CACHE_KEYS.productStock,
  };
}
