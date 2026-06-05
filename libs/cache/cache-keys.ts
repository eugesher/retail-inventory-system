// Central registry of cache-key templates. Every cache key in `apps/*/src`
// must come from this file — no string literals. Three key families coexist:
//
//   * **Current convention** (ADR-022): includes a per-aggregate
//     schema-version segment (defaulted at the builder) and an opt-in
//     tenant segment near the root:
//       `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`.
//     Examples:
//       - `ris:inventory:stock:v1:42:__all__`                 — single-tenant
//       - `ris:t:store-7:inventory:stock:v1:42:__all__`        — tenant supplied
//       - `ris:inventory:stock:v1:42:head-warehouse,west-warehouse`
//       - `ris:retail:order:v1:7:__all__`
//
//   * **Pre-v1 (post-ADR-016) convention**: `ris:<service>:<aggregate>:<id>[:<facet>]`
//     — no version segment. Exposed as `inventoryStockLegacyPrefix` *only*
//     so the invalidate path can wipe in-flight entries written under the
//     old prefix during the rolling deploy that adopts v1.
//
//   * **Pre-ADR-016 legacy convention**: `stock:<productId>:[*|<storageIds>]`.
//     Kept as builders so `StockCache.invalidate` can SCAN+UNLINK in-flight
//     entries during the original ADR-016 transition window.
//
// Audit findings tracked here:
//   * `CACHE-010` (storage-id sort comparator) and `CACHE-011` (literal-`*`
//     sentinel) — closed by ADR-016 via the `inventoryStock*` builders.
//   * `CACHE-003` (schema-version segment) and `CACHE-009` (tenant
//     segment) — closed by ADR-022 via the version constant and the
//     opt-in `opts.tenantId` argument below.

// Per-aggregate schema versions. Bumping any of these is a one-line edit
// that re-keys every entry on the next deploy; the StockCache invalidate
// path keeps wiping the pre-bump shape for one transition window.
const INVENTORY_STOCK_KEY_VERSION = 'v1';
const RETAIL_ORDER_KEY_VERSION = 'v1';
// Reserved for a future cached catalog read path. The catalog product cache is
// keyed on `variantId` (not `productId`) because the variant is the downstream
// backbone — inventory stock, pricing, and order lines all key on the variant
// (ADR-025). The `catalogProduct*` builders below are not consumed yet.
const CATALOG_PRODUCT_KEY_VERSION = 'v1';
// Reserved for a future cached pricing read path (Select Applicable Price). Keyed
// on `(variantId, currency)` because that pair is the entire price scope (ADR-026)
// — the variant is the downstream backbone (ADR-025) and currency is the only
// other axis. The `catalogPrice*` builders below are not consumed yet: the pricing
// module does not import `CacheModule` (the threshold for caching pricing reads is
// unmet). They exist so a future cached read path adopts the v1 key shape without
// re-keying; a bump of this constant re-keys every entry on the next deploy.
const CATALOG_PRICE_KEY_VERSION = 'v1';

// Sentinel for the "every facet for this id" key. Non-glob so the literal
// cannot be confused with a Redis MATCH pattern (CACHE-011 fix from ADR-016).
const ALL_FACETS_SENTINEL = '__all__';

interface ITenantOptions {
  tenantId?: string;
}

// Assembles the `ris:[t:<tenantId>:]` root prefix. Tenant is opt-in by
// argument; a missing `tenantId` means single-tenant mode and the segment
// is omitted entirely (not defaulted to `default` — see ADR-022 §"Tenant
// is opt-in, not defaulted").
const rootPrefix = (opts?: ITenantOptions): string =>
  opts?.tenantId ? `ris:t:${opts.tenantId}:` : 'ris:';

const sortedStorageFacet = (storageIds: readonly string[]): string =>
  [...storageIds].sort((a, b) => a.localeCompare(b)).join(',');

export const CACHE_KEYS = {
  // -- Current convention (ADR-022 — version + opt-in tenant) ---------------
  inventoryStockPrefix: (productId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}inventory:stock:${INVENTORY_STOCK_KEY_VERSION}:${productId}:`,

  inventoryStock: (productId: number, storageIds?: string[], opts?: ITenantOptions): string => {
    const prefix = CACHE_KEYS.inventoryStockPrefix(productId, opts);
    const facet =
      storageIds && storageIds.length > 0 ? sortedStorageFacet(storageIds) : ALL_FACETS_SENTINEL;
    return `${prefix}${facet}`;
  },

  retailOrderPrefix: (orderId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}retail:order:${RETAIL_ORDER_KEY_VERSION}:${orderId}:`,

  retailOrder: (orderId: number, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.retailOrderPrefix(orderId, opts)}${ALL_FACETS_SENTINEL}`,

  // Reserved catalog read-path builder (ADR-016 / ADR-022). Keyed on
  // `variantId` — the variant is the unit with a stock/price/order-line, so a
  // future cached catalog read path keys on it rather than the product
  // (ADR-025). **Not consumed yet**: the catalog service does not import
  // `CacheModule`; this builder + `CATALOG_PRODUCT_KEY_VERSION` exist so the
  // future cached read path can adopt the v1 key shape without re-keying.
  catalogProductPrefix: (variantId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}catalog:product:${CATALOG_PRODUCT_KEY_VERSION}:${variantId}:`,

  catalogProduct: (variantId: number, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.catalogProductPrefix(variantId, opts)}${ALL_FACETS_SENTINEL}`,

  // Reserved pricing read-path builder (ADR-016 / ADR-022 / ADR-026). Keyed on
  // `(variantId, currency)` — the entire price scope. **Not consumed yet**: the
  // pricing module does not import `CacheModule`; this builder +
  // `CATALOG_PRICE_KEY_VERSION` exist so a future cached Select-Applicable-Price
  // read path can adopt the v1 key shape without re-keying. Key shape:
  // `ris:[t:<tenantId>:]catalog:price:v1:<variantId>:<currency>`.
  catalogPricePrefix: (variantId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}catalog:price:${CATALOG_PRICE_KEY_VERSION}:${variantId}:`,

  catalogPrice: (variantId: number, currency: string, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.catalogPricePrefix(variantId, opts)}${currency}`,

  // -- Pre-v1 (post-ADR-016) shape — invalidate-only ------------------------
  // Returns the pre-v1 stock prefix `ris:inventory:stock:<productId>:`.
  // Exposed solely so `StockCache.invalidate` can wipe in-flight entries
  // written under the pre-v1 shape during the rolling deploy that adopts
  // v1 (ADR-022 transition window). Reads and writes MUST use
  // `inventoryStockPrefix` / `inventoryStock` above; this builder is for
  // SCAN+UNLINK only and is unconditionally single-tenant — the pre-v1
  // shape never carried a tenant segment, so there is nothing to scope.
  inventoryStockLegacyPrefix: (productId: number): string => `ris:inventory:stock:${productId}:`,

  // -- Pre-ADR-016 legacy convention ----------------------------------------
  // Retained so the SCAN-based invalidate path can wipe entries written
  // under the original `stock:<productId>:*` prefix during the ADR-016
  // transition window. New writes always use the `inventoryStock*`
  // builders above.
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

// Backwards-compat alias surface. Prefer `CACHE_KEYS` builders for new code.
export class CacheHelper {
  public static keyPrefixes = {
    productStock: CACHE_KEYS.productStockPrefix,
  };

  public static keys = {
    productStock: CACHE_KEYS.productStock,
  };
}
