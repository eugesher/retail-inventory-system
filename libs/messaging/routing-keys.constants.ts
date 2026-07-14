// The wire format is `<service>.<aggregate>.<action>` (ADR-008), and the namespace names the
// queue: an `inventory.*` key rides `inventory_queue`, a `retail.*` key rides `retail_queue`.
// The exception is an event, which is emitted onto the queue of whoever CONSUMES it rather than
// the producer's own (ADR-008/020) — so a `retail.*` event with a notification consumer is
// published on `notification_events`.
//
// Every key is additionally mirrored onto the `ris.events` topic exchange, where the event-store
// firehose binds `#` (ADR-035). A key with no business consumer is therefore a **reserved
// surface**, not a dead one: still captured, still queryable. That is a decision, not an
// omission — do not "fix" it by deleting the key.
//
// Which use case serves a key, which controller answers it, whether it has an HTTP route, and
// which keys are reserved surfaces: **README §2**. None of it is restated here. A second copy of
// that table would drift from the first, and the copy nobody maintains is the one the next
// reader believes.
//
// The comments below record only what the key itself will not tell you.
export const ROUTING_KEYS = {
  INVENTORY_STOCK_LOW: 'inventory.stock.low',
  INVENTORY_STOCK_RECEIVED: 'inventory.stock.received',
  INVENTORY_STOCK_ADJUSTED: 'inventory.stock.adjusted',
  INVENTORY_STOCK_LEVEL_GET: 'inventory.stock-level.get',
  INVENTORY_STOCK_LEVEL_RECEIVE: 'inventory.stock-level.receive',
  INVENTORY_STOCK_LEVEL_ADJUST: 'inventory.stock-level.adjust',
  INVENTORY_STOCK_LEVEL_TRANSFER: 'inventory.stock-level.transfer',
  INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized',
  INVENTORY_LOCATION_LIST: 'inventory.location.list',
  INVENTORY_STOCK_MOVEMENT_LIST: 'inventory.stock-movement.list',
  INVENTORY_RESERVATION_RESERVE: 'inventory.reservation.reserve',
  INVENTORY_RESERVATION_RELEASE: 'inventory.reservation.release',
  INVENTORY_RESERVATION_SWEEP: 'inventory.reservation.sweep',
  // `allocation` is an RPC-subject noun — the counters and ledger rows the operation acts on —
  // not a persisted aggregate. The pseudo-aggregate naming precedent (ADR-030 §5).
  INVENTORY_RESERVATION_ALLOCATE: 'inventory.reservation.allocate',
  INVENTORY_ALLOCATION_CANCEL: 'inventory.allocation.cancel',
  INVENTORY_STOCK_RESERVED: 'inventory.stock.reserved',
  INVENTORY_STOCK_ALLOCATED: 'inventory.stock.allocated',
  INVENTORY_STOCK_RELEASED: 'inventory.stock.released',
  INVENTORY_STOCK_MOVEMENT_RECORDED: 'inventory.stock-movement.recorded',
  INVENTORY_STOCK_COMMIT_SALE: 'inventory.stock.commit-sale',
  INVENTORY_STOCK_COMMITTED: 'inventory.stock.committed',
  INVENTORY_STOCK_RESTOCK_FROM_RETURN: 'inventory.stock.restock-from-return',
  INVENTORY_STOCK_RETURNED: 'inventory.stock.returned',
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
  // The category and media capabilities emit NO events. There is no past-tense
  // `catalog.category.*` / `catalog.media.*` key to pair with these commands, and its absence is
  // the decision, not an oversight (ADR-029 §6) — an absence no comment on an existing key can
  // record, which is why it is recorded here.
  CATALOG_CATEGORY_CREATE: 'catalog.category.create',
  CATALOG_CATEGORY_REPARENT: 'catalog.category.reparent',
  CATALOG_CATEGORY_LIST: 'catalog.category.list',
  CATALOG_CATEGORY_GET_TREE: 'catalog.category.get-tree',
  CATALOG_CATEGORY_LIST_PRODUCTS: 'catalog.category.list-products',
  // A `product.*` key served by the CATEGORY controller: the operation's subject is the category
  // membership, not the product header (the `retail.cart.place` precedent below).
  CATALOG_PRODUCT_RECLASSIFY: 'catalog.product.reclassify',
  CATALOG_MEDIA_ATTACH: 'catalog.media.attach',
  CATALOG_MEDIA_REORDER: 'catalog.media.reorder',
  CATALOG_MEDIA_DETACH: 'catalog.media.detach',
  CATALOG_MEDIA_LIST: 'catalog.media.list',
  RETAIL_CART_CREATE: 'retail.cart.create',
  RETAIL_CART_GET: 'retail.cart.get',
  RETAIL_CART_ADD_LINE: 'retail.cart.add-line',
  RETAIL_CART_CHANGE_LINE_QUANTITY: 'retail.cart.change-line-quantity',
  RETAIL_CART_REMOVE_LINE: 'retail.cart.remove-line',
  RETAIL_CART_CLAIM: 'retail.cart.claim',
  // A `cart.*` key served by the ORDERS controller: it acts on the cart, but what it produces is
  // an `Order` (ADR-028 §1).
  RETAIL_CART_PLACE: 'retail.cart.place',
  RETAIL_ORDER_GET: 'retail.order.get',
  RETAIL_ORDER_LIST: 'retail.order.list',
  RETAIL_PAYMENT_CAPTURE: 'retail.payment.capture',
  RETAIL_FULFILLMENT_CREATE: 'retail.fulfillment.create',
  RETAIL_FULFILLMENT_LIST: 'retail.fulfillment.list',
  RETAIL_FULFILLMENT_SHIP: 'retail.fulfillment.ship',
  RETAIL_FULFILLMENT_DELIVER: 'retail.fulfillment.deliver',
  RETAIL_ORDER_CANCEL: 'retail.order.cancel',
  RETAIL_ORDER_CANCEL_LINE: 'retail.order.cancel-line',
  RETAIL_RETURN_OPEN: 'retail.return.open',
  RETAIL_RETURN_AUTHORIZE: 'retail.return.authorize',
  RETAIL_RETURN_REJECT: 'retail.return.reject',
  RETAIL_RETURN_RECEIVE: 'retail.return.receive',
  RETAIL_RETURN_INSPECT: 'retail.return.inspect',
  RETAIL_RETURN_CLOSE: 'retail.return.close',
  RETAIL_RETURN_GET: 'retail.return.get',
  RETAIL_RETURN_LIST: 'retail.return.list',
  RETAIL_REFUND_ISSUE: 'retail.refund.issue',
  RETAIL_REFUND_LIST: 'retail.refund.list',
  RETAIL_CART_CREATED: 'retail.cart.created',
  RETAIL_CART_LINE_ADDED: 'retail.cart.line-added',
  RETAIL_CART_LINE_REMOVED: 'retail.cart.line-removed',
  RETAIL_CART_LINE_QUANTITY_CHANGED: 'retail.cart.line-quantity-changed',
  RETAIL_ORDER_PLACED: 'retail.order.placed',
  RETAIL_PAYMENT_AUTHORIZED: 'retail.payment.authorized',
  RETAIL_PAYMENT_CAPTURED: 'retail.payment.captured',
  RETAIL_FULFILLMENT_CREATED: 'retail.fulfillment.created',
  RETAIL_FULFILLMENT_SHIPPED: 'retail.fulfillment.shipped',
  RETAIL_FULFILLMENT_DELIVERED: 'retail.fulfillment.delivered',
  RETAIL_ORDER_CANCELLED: 'retail.order.cancelled',
  RETAIL_RETURN_REQUESTED: 'retail.return.requested',
  RETAIL_RETURN_AUTHORIZED: 'retail.return.authorized',
  RETAIL_RETURN_REJECTED: 'retail.return.rejected',
  RETAIL_RETURN_RECEIVED: 'retail.return.received',
  RETAIL_RETURN_INSPECTED: 'retail.return.inspected',
  RETAIL_RETURN_CLOSED: 'retail.return.closed',
  RETAIL_REFUND_ISSUED: 'retail.refund.issued',
  RETAIL_REFUND_FAILED: 'retail.refund.failed',
  // Liveness probes, one per RMQ deployable — each rides that service's existing queue rather
  // than one of its own (ADR-044).
  NOTIFICATION_HEALTH_PING: 'notification.health.ping',
  CATALOG_HEALTH_PING: 'catalog.health.ping',
  INVENTORY_HEALTH_PING: 'inventory.health.ping',
  RETAIL_HEALTH_PING: 'retail.health.ping',
  AUDIT_HEALTH_PING: 'audit.health.ping',
  NOTIFICATION_TEMPLATE_AUTHOR: 'notification.template.author',
  NOTIFICATION_TEMPLATE_SET_ACTIVE: 'notification.template.set-active',
  NOTIFICATION_TEMPLATE_LIST: 'notification.template.list',
  NOTIFICATION_DELIVERY_LIST: 'notification.delivery.list',
  NOTIFICATION_DELIVERY_GET: 'notification.delivery.get',
  NOTIFICATION_DELIVERY_RECORD_OUTCOME: 'notification.delivery.record-outcome',
  NOTIFICATION_DELIVERY_RETRY: 'notification.delivery.retry',
  // Plural `notifications.*`, deliberately: the cross-cutting alerting stream, not one of the
  // singular `notification.delivery.*` RPC commands (ADR-033).
  NOTIFICATIONS_DELIVERY_FAILED: 'notifications.delivery.failed',
  NOTIFICATION_MARKETING_SEND: 'notification.marketing.send',
  // NOT a queue subject — the one entry in this map that is not a routing key. It is a
  // template-registry key: the `eventType` half of the `(eventType, channel, locale)` natural key
  // the marketing template is authored under (`scripts/seeds/notification-template.sql`). It lives
  // in a shared lib precisely so the seed and the gateway's default cannot disagree — they are the
  // same constant. Deliberately absent from `TRANSACTIONAL_EVENT_TYPES`, so the consent gate
  // treats a send of it as marketing (ADR-037).
  MARKETING_EMAIL_PROMO: 'marketing.email.promo',
  CUSTOMER_CONSENT_UPDATED: 'customer.consent.updated',
  CUSTOMER_ERASED: 'customer.erased',
  // The one `audit.*` EVENT. It rides the `ris.events` exchange rather than a service queue, and
  // it is the only key the firehose dispatches to `audit_log_entry` instead of `domain_event`
  // (ADR-035/039). The three `audit.*` keys below it are RPCs and never travel the exchange.
  AUDIT_STAFF_ACTION: 'audit.staff.action',
  AUDIT_EVENT_QUERY: 'audit.event.query',
  AUDIT_ENTRY_QUERY: 'audit.entry.query',
  AUDIT_TRACE_BY_CORRELATION: 'audit.trace.by-correlation',
} as const;

export type RoutingKey = (typeof ROUTING_KEYS)[keyof typeof ROUTING_KEYS];
