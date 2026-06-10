export const ROUTING_KEYS = {
  INVENTORY_ORDER_CONFIRM: 'inventory.order.confirm',
  INVENTORY_STOCK_LOW: 'inventory.stock.low',
  INVENTORY_STOCK_RECEIVED: 'inventory.stock.received',
  INVENTORY_STOCK_ADJUSTED: 'inventory.stock.adjusted',
  INVENTORY_STOCK_LEVEL_GET: 'inventory.stock-level.get',
  INVENTORY_STOCK_LEVEL_RECEIVE: 'inventory.stock-level.receive',
  INVENTORY_STOCK_LEVEL_ADJUST: 'inventory.stock-level.adjust',
  INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized',
  INVENTORY_LOCATION_LIST: 'inventory.location.list',
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
  CATALOG_PRICE_SET: 'catalog.price.set',
  CATALOG_PRICE_LIST: 'catalog.price.list',
  CATALOG_PRICE_SELECT: 'catalog.price.select',
  CATALOG_PRICE_CHANGED: 'catalog.price.changed',
  CATALOG_PRICE_SCHEDULED: 'catalog.price.scheduled',
  CATALOG_TAX_CATEGORY_CREATE: 'catalog.tax-category.create',
  CATALOG_TAX_CATEGORY_LIST: 'catalog.tax-category.list',
  CATALOG_VARIANT_SET_TAX_CATEGORY: 'catalog.variant.set-tax-category',
  // Cart RPC command keys (API Gateway → Retail). Each is served by a
  // `@MessagePattern` handler on the retail cart controller and resolves to a
  // `CartView`; `retail.cart.claim` is the guest-promotion re-point (ADR-028 §9).
  RETAIL_CART_CREATE: 'retail.cart.create',
  RETAIL_CART_GET: 'retail.cart.get',
  RETAIL_CART_ADD_LINE: 'retail.cart.add-line',
  RETAIL_CART_CHANGE_LINE_QUANTITY: 'retail.cart.change-line-quantity',
  RETAIL_CART_REMOVE_LINE: 'retail.cart.remove-line',
  RETAIL_CART_CLAIM: 'retail.cart.claim',
  // `retail.cart.place` — the Place Order RPC (API Gateway → Retail). It converts
  // the active cart into an immutable `Order` one-shot, snapshots the lines and
  // addresses, authorizes payment inline, and resolves to an `OrderView`. It is a
  // cart key (it acts on the cart) but is served by the orders controller, since
  // the placement produces an `Order` (ADR-028 §1).
  RETAIL_CART_PLACE: 'retail.cart.place',
  // Reserved-surface cart events (no consumer bound yet) — emitted onto
  // `retail_queue` by the cart operations. These are past-tense notifications,
  // distinct from the imperative command keys above.
  RETAIL_CART_CREATED: 'retail.cart.created',
  RETAIL_CART_LINE_ADDED: 'retail.cart.line-added',
  RETAIL_CART_LINE_REMOVED: 'retail.cart.line-removed',
  RETAIL_CART_LINE_QUANTITY_CHANGED: 'retail.cart.line-quantity-changed',
  // `retail.order.placed` — emitted onto `notification_events` after a successful
  // place so the notification service can fan out an order confirmation. An active
  // consumer arrives with the notification re-point capability; for now it is a
  // best-effort post-commit emit (ADR-020).
  RETAIL_ORDER_PLACED: 'retail.order.placed',
  // `retail.payment.authorized` — emitted onto `retail_queue` (the producer's own
  // queue) after authorize-on-place succeeds. A reserved surface today, like the
  // four `retail.cart.*` events.
  RETAIL_PAYMENT_AUTHORIZED: 'retail.payment.authorized',
  NOTIFICATION_HEALTH_PING: 'notification.health.ping',
} as const;

export type RoutingKey = (typeof ROUTING_KEYS)[keyof typeof ROUTING_KEYS];
