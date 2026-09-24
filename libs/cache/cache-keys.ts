const INVENTORY_STOCK_KEY_VERSION = 'v3';
const RETAIL_ORDER_KEY_VERSION = 'v1';
const CATALOG_PRODUCT_KEY_VERSION = 'v1';
const CATALOG_PRICE_KEY_VERSION = 'v1';
const CATALOG_CATEGORY_KEY_VERSION = 'v1';
const NOTIFICATIONS_TEMPLATE_KEY_VERSION = 'v1';
const NOTIFICATIONS_CONSENT_KEY_VERSION = 'v1';

const ALL_FACETS_SENTINEL = '__all__';

interface ITenantOptions {
  tenantId?: string;
}

const rootPrefix = (opts?: ITenantOptions): string =>
  opts?.tenantId ? `ris:t:${opts.tenantId}:` : 'ris:';

const sortedStockLocationFacet = (stockLocationIds: readonly string[]): string =>
  [...stockLocationIds].sort((a, b) => a.localeCompare(b)).join(',');

export const CACHE_KEYS = {
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

  catalogProductPrefix: (variantId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}catalog:product:${CATALOG_PRODUCT_KEY_VERSION}:${variantId}:`,

  catalogProduct: (variantId: number, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.catalogProductPrefix(variantId, opts)}${ALL_FACETS_SENTINEL}`,

  catalogPricePrefix: (variantId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}catalog:price:${CATALOG_PRICE_KEY_VERSION}:${variantId}:`,

  catalogPrice: (variantId: number, currency: string, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.catalogPricePrefix(variantId, opts)}${currency}`,

  catalogCategoryTree: (opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}catalog:category-tree:${CATALOG_CATEGORY_KEY_VERSION}`,

  catalogCategoryChildrenPrefix: (categoryId: number, opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}catalog:category:${CATALOG_CATEGORY_KEY_VERSION}:${categoryId}:`,

  catalogCategoryChildren: (categoryId: number, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.catalogCategoryChildrenPrefix(categoryId, opts)}children`,

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

  notificationsConsentPrefix: (opts?: ITenantOptions): string =>
    `${rootPrefix(opts)}notifications:consent:${NOTIFICATIONS_CONSENT_KEY_VERSION}:`,

  notificationsConsent: (customerId: string, opts?: ITenantOptions): string =>
    `${CACHE_KEYS.notificationsConsentPrefix(opts)}${customerId}`,

  inventoryStockLegacyPrefixV2: (id: number): string => `ris:inventory:stock:v2:${id}:`,

  inventoryStockLegacyPrefixV1: (id: number): string => `ris:inventory:stock:v1:${id}:`,

  inventoryStockLegacyPrefix: (id: number): string => `ris:inventory:stock:${id}:`,

  productStockPrefix: (productId: number): string => `stock:${productId}:`,
} as const;
