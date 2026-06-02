// Wire-format routing keys. Kept in lock-step with `ROUTING_KEYS` in
// libs/messaging — this enum is the source of truth, `ROUTING_KEYS` is the
// idiomatic constants surface for new callers.
export enum MicroserviceMessagePatternEnum {
  INVENTORY_PRODUCT_STOCK_GET = 'inventory.product-stock.get',
  INVENTORY_ORDER_CONFIRM = 'inventory.order.confirm',
  INVENTORY_STOCK_LOW = 'inventory.stock.low',
  RETAIL_ORDER_CREATE = 'retail.order.create',
  RETAIL_ORDER_CONFIRM = 'retail.order.confirm',
  RETAIL_ORDER_GET = 'retail.order.get',
  RETAIL_ORDER_CREATED = 'retail.order.created',
  RETAIL_ORDER_CONFIRMED = 'retail.order.confirmed',
  RETAIL_ORDER_CANCELLED = 'retail.order.cancelled',
  CATALOG_PRODUCT_REGISTER = 'catalog.product.register',
  CATALOG_PRODUCT_PUBLISH = 'catalog.product.publish',
  CATALOG_PRODUCT_ARCHIVE = 'catalog.product.archive',
  CATALOG_VARIANT_CREATE = 'catalog.variant.create',
  CATALOG_VARIANT_CREATED = 'catalog.variant.created',
  CATALOG_PRODUCT_PUBLISHED = 'catalog.product.published',
  CATALOG_PRODUCT_ARCHIVED = 'catalog.product.archived',
  NOTIFICATION_HEALTH_PING = 'notification.health.ping',
}
