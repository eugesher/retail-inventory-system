// Dotted routing-key constants — `<service>.<aggregate>.<action>`. Replaces
// the underscored `MicroserviceMessagePatternEnum` values that lived in
// libs/contracts/microservices. The breaking rename to dotted conventions
// is recorded in ADR-008.
export const ROUTING_KEYS = {
  RETAIL_ORDER_CREATE: 'retail.order.create',
  RETAIL_ORDER_CONFIRM: 'retail.order.confirm',
  RETAIL_ORDER_GET: 'retail.order.get',
  INVENTORY_PRODUCT_STOCK_GET: 'inventory.product-stock.get',
  INVENTORY_ORDER_CONFIRM: 'inventory.order.confirm',
} as const;

export type RoutingKey = (typeof ROUTING_KEYS)[keyof typeof ROUTING_KEYS];
