// Wire-format routing keys. Renamed from snake_case to dotted
// `<service>.<aggregate>.<action>` in task-04 (ADR-008). The values are kept
// in sync with `ROUTING_KEYS` in libs/messaging — the enum stays here as the
// source of truth for transport identifiers, and `ROUTING_KEYS` re-exposes
// the same strings as a more idiomatic constants object for new callers.
export enum MicroserviceMessagePatternEnum {
  INVENTORY_PRODUCT_STOCK_GET = 'inventory.product-stock.get',
  INVENTORY_ORDER_CONFIRM = 'inventory.order.confirm',
  INVENTORY_STOCK_LOW = 'inventory.stock.low',
  RETAIL_ORDER_CREATE = 'retail.order.create',
  RETAIL_ORDER_CONFIRM = 'retail.order.confirm',
  RETAIL_ORDER_GET = 'retail.order.get',
  RETAIL_ORDER_CREATED = 'retail.order.created',
  NOTIFICATION_HEALTH_PING = 'notification.health.ping',
}
