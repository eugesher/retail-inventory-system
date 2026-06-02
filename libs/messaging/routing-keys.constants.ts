export const ROUTING_KEYS = {
  RETAIL_ORDER_CREATE: 'retail.order.create',
  RETAIL_ORDER_CONFIRM: 'retail.order.confirm',
  RETAIL_ORDER_GET: 'retail.order.get',
  RETAIL_ORDER_CREATED: 'retail.order.created',
  RETAIL_ORDER_CONFIRMED: 'retail.order.confirmed',
  RETAIL_ORDER_CANCELLED: 'retail.order.cancelled',
  INVENTORY_PRODUCT_STOCK_GET: 'inventory.product-stock.get',
  INVENTORY_ORDER_CONFIRM: 'inventory.order.confirm',
  INVENTORY_STOCK_LOW: 'inventory.stock.low',
  CATALOG_PRODUCT_REGISTER: 'catalog.product.register',
  CATALOG_PRODUCT_PUBLISH: 'catalog.product.publish',
  CATALOG_PRODUCT_ARCHIVE: 'catalog.product.archive',
  CATALOG_VARIANT_CREATE: 'catalog.variant.create',
  CATALOG_VARIANT_CREATED: 'catalog.variant.created',
  CATALOG_PRODUCT_PUBLISHED: 'catalog.product.published',
  CATALOG_PRODUCT_ARCHIVED: 'catalog.product.archived',
  CATALOG_PRODUCT_LIST: 'catalog.product.list',
  CATALOG_PRODUCT_GET: 'catalog.product.get',
  CATALOG_VARIANT_GET: 'catalog.variant.get',
  NOTIFICATION_HEALTH_PING: 'notification.health.ping',
} as const;

export type RoutingKey = (typeof ROUTING_KEYS)[keyof typeof ROUTING_KEYS];
