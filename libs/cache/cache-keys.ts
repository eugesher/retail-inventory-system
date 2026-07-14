// Every cache key in `apps/*/src` is built here. No key string literals anywhere else
// (ADR-016 / ADR-022). The shape:
//
//   ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]
//
// Five stock key families coexist: the live `v3` and four retired shapes exposed
// **invalidate-only**, so the write path can wipe entries a previous deploy wrote. Read or write
// through a legacy builder and you will hit a shape nothing else maintains. Why each bump
// happened is ADR-016 / ADR-022 / ADR-030 §7.

// Per-aggregate schema versions. A bump is a one-line edit that re-keys every entry on the next
// deploy.
//
// Only `INVENTORY_STOCK_KEY_VERSION` and `NOTIFICATIONS_CONSENT_KEY_VERSION` have a consumer.
// The rest are **deliberately reserved**: their services do not import `CacheModule`, and the
// builders exist so a future cached read path adopts the v1 shape without re-keying. ADR-046
// kept them on exactly that basis — *"one line in a registry, where being a complete registry is
// the point"* — while deleting the dead *implementations* around them. Do not sweep them as
// dead code.
const INVENTORY_STOCK_KEY_VERSION = 'v3';
const RETAIL_ORDER_KEY_VERSION = 'v1';
const CATALOG_PRODUCT_KEY_VERSION = 'v1';
const CATALOG_PRICE_KEY_VERSION = 'v1';
const CATALOG_CATEGORY_KEY_VERSION = 'v1';
const NOTIFICATIONS_TEMPLATE_KEY_VERSION = 'v1';
const NOTIFICATIONS_CONSENT_KEY_VERSION = 'v1';

// Non-glob on purpose: a literal `*` here would be indistinguishable from a Redis MATCH pattern
// (ADR-016).
const ALL_FACETS_SENTINEL = '__all__';

interface ITenantOptions {
  tenantId?: string;
}

// A missing `tenantId` omits the segment entirely rather than defaulting it to `default` — the
// single-tenant key must not carry a tenant-shaped lie (ADR-022 §"Tenant is opt-in, not
// defaulted").
const rootPrefix = (opts?: ITenantOptions): string =>
  opts?.tenantId ? `ris:t:${opts.tenantId}:` : 'ris:';

// Sorted so that `[west, head]` and `[head, west]` resolve to the same key. Without it the same
// location set caches twice and invalidates once.
const sortedStockLocationFacet = (stockLocationIds: readonly string[]): string =>
  [...stockLocationIds].sort((a, b) => a.localeCompare(b)).join(',');

export const CACHE_KEYS = {
  // -- Live builders ---------------------------------------------------------
  inventoryStockPrefix: (variantId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}inventory:stock:${INVENTORY_STOCK_KEY_VERSION}:${variantId}:`,

  inventoryStock: (
    variantId: number,
    stockLocationIds?: string[],
    opts?: ITenantOptions,
  ): string => {
    const prefix = CACHE_KEYS.inventoryStockPrefix(variantId, opts);
    const facet =
      stockLocationIds && stockLocationIds.length > 0
        ? sortedStockLocationFacet(stockLocationIds)
        : ALL_FACETS_SENTINEL;
    return `${prefix}${facet}`;
  },

  retailOrderPrefix: (orderId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}retail:order:${RETAIL_ORDER_KEY_VERSION}:${orderId}:`,

  retailOrder: (orderId: number, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.retailOrderPrefix(orderId, opts)}${ALL_FACETS_SENTINEL}`,

  // -- Reserved builders (no caller — see the note on the version constants) --
  catalogProductPrefix: (variantId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}catalog:product:${CATALOG_PRODUCT_KEY_VERSION}:${variantId}:`,

  catalogProduct: (variantId: number, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.catalogProductPrefix(variantId, opts)}${ALL_FACETS_SENTINEL}`,

  catalogPricePrefix: (variantId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}catalog:price:${CATALOG_PRICE_KEY_VERSION}:${variantId}:`,

  catalogPrice: (variantId: number, currency: string, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.catalogPricePrefix(variantId, opts)}${currency}`,

  // The tree is a singleton — one materialized hierarchy, no `<id>` axis — so this key
  // terminates at the version segment while its sibling below does not. The asymmetry is
  // deliberate; do not "align" them.
  catalogCategoryTree: (opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}catalog:category-tree:${CATALOG_CATEGORY_KEY_VERSION}`,

  catalogCategoryChildrenPrefix: (categoryId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}catalog:category:${CATALOG_CATEGORY_KEY_VERSION}:${categoryId}:`,

  catalogCategoryChildren: (categoryId: number, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.catalogCategoryChildrenPrefix(categoryId, opts)}children`,

  // The `<id>` axis is the composite natural key `(eventType, channel, locale)` — a template is
  // resolved by that triple, not by a surrogate id. The prefix stops one segment short of the
  // locale so one `delByPrefix` wipes every locale under a channel.
  notificationsTemplatePrefix: (
    eventType: string,
    channel: string,
    opts?: ITenantOptions,
  ): string =>
    `${rootPrefix(opts)}notifications:template:${NOTIFICATIONS_TEMPLATE_KEY_VERSION}:${eventType}:${channel}:`,

  notificationsTemplate: (
    eventType: string,
    channel: string,
    locale: string,
    opts?: ITenantOptions,
  ): string => `${CACHE_KEYS.notificationsTemplatePrefix(eventType, channel, opts)}${locale}`,

  // The consent snapshot is a singleton per customer — no facet — so the prefix stops one
  // segment short of the id and a `delByPrefix` wipes the entry itself (ADR-037).
  notificationsConsentPrefix: (opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}notifications:consent:${NOTIFICATIONS_CONSENT_KEY_VERSION}:`,

  notificationsConsent: (customerId: string, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.notificationsConsentPrefix(opts)}${customerId}`,

  // -- Retired shapes: SCAN+UNLINK only, never read, never written -----------
  // `StockCache.withInvalidation` feeds each of these to `delByPrefix` so a rolling deploy
  // wipes whatever the previous key version left behind. There is deliberately no full-key
  // builder to match any of them: nothing writes these shapes, so a complete key would have no
  // caller (ADR-046 deleted the one that did). Do not add one back for symmetry.
  //
  // The v1 family keyed the old `productId` axis; these wipe by the now-`variantId` numeric id
  // instead, which is close enough for a transition window and exact enough for a tree with no
  // production data.
  inventoryStockLegacyPrefixV2: (id: number): string => `ris:inventory:stock:v2:${id}:`,

  inventoryStockLegacyPrefixV1: (id: number): string => `ris:inventory:stock:v1:${id}:`,

  // Pre-v1: no version segment, and unconditionally single-tenant — that shape never carried a
  // tenant, so there is nothing to scope.
  inventoryStockLegacyPrefix: (id: number): string => `ris:inventory:stock:${id}:`,

  // Pre-ADR-016: the original `stock:<productId>:*` convention, before keys were namespaced.
  productStockPrefix: (productId: number): string => `stock:${productId}:`,
} as const;
