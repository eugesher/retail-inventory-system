export const ROUTING_KEYS = {
  INVENTORY_STOCK_LOW: 'inventory.stock.low',
  INVENTORY_STOCK_RECEIVED: 'inventory.stock.received',
  INVENTORY_STOCK_ADJUSTED: 'inventory.stock.adjusted',
  INVENTORY_STOCK_LEVEL_GET: 'inventory.stock-level.get',
  INVENTORY_STOCK_LEVEL_RECEIVE: 'inventory.stock-level.receive',
  INVENTORY_STOCK_LEVEL_ADJUST: 'inventory.stock-level.adjust',
  // `inventory.stock-level.transfer` → `TransferStockUseCase` (RPC, Gateway →
  // Inventory): moves on-hand between two locations of one variant atomically —
  // two `StockLevel` writes + two paired `adjustment` movements (sharing a
  // `transfer` reference id) in one transaction (ADR-030). The `stock-level`
  // aggregate noun matches the receive/adjust keys.
  INVENTORY_STOCK_LEVEL_TRANSFER: 'inventory.stock-level.transfer',
  INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized',
  INVENTORY_LOCATION_LIST: 'inventory.location.list',
  // `inventory.stock-movement.list` → `ListStockMovementsUseCase` (RPC, Gateway →
  // Inventory): the paginated, filterable, newest-first audit read of one variant's
  // `stock_movement` ledger rows → `IPage<StockMovementView>`. Backs the operator
  // audit endpoint `GET /api/inventory/variants/:variantId/movements` (ADR-030 §2/§5).
  INVENTORY_STOCK_MOVEMENT_LIST: 'inventory.stock-movement.list',
  // Reservation RPC commands (Gateway / Retail → Inventory on `inventory_queue`,
  // each served by a `@MessagePattern` handler on the inventory stock controller):
  // `inventory.reservation.reserve` → `ReserveStockUseCase` → `ReservationView`,
  // `inventory.reservation.release` → `ReleaseReservationUseCase` →
  // `IReservationReleaseResult` (ADR-030 §5).
  INVENTORY_RESERVATION_RESERVE: 'inventory.reservation.reserve',
  INVENTORY_RESERVATION_RELEASE: 'inventory.reservation.release',
  // `inventory.reservation.allocate` → `AllocateStockUseCase` → `IAllocationResult`
  // (converts a cart's holds into an order's allocations at place-time, with a
  // direct-allocation fallback) and `inventory.allocation.cancel` →
  // `CancelAllocationUseCase` (reverses an order's allocation — the later
  // order-cancel flow + the place-failure compensation). NOTE: `allocation` is an
  // RPC-subject noun (the counters + ledger rows the operation acts on), not a
  // persisted aggregate — the pseudo-aggregate naming precedent (ADR-030 §5).
  INVENTORY_RESERVATION_ALLOCATE: 'inventory.reservation.allocate',
  INVENTORY_ALLOCATION_CANCEL: 'inventory.allocation.cancel',
  // Reservation + ledger events — reserved surfaces on `inventory_queue` (no
  // cross-service consumer yet; the intended consumer is a future event-store
  // capability — the `inventory.stock.{received,adjusted}` precedent).
  // `inventory.stock.reserved` (Reserve) / `inventory.stock.allocated` (Allocate) /
  // `inventory.stock.released` (Release + Cancel-Allocation) and the high-volume
  // `inventory.stock-movement.recorded` (every ledger insert).
  INVENTORY_STOCK_RESERVED: 'inventory.stock.reserved',
  INVENTORY_STOCK_ALLOCATED: 'inventory.stock.allocated',
  INVENTORY_STOCK_RELEASED: 'inventory.stock.released',
  INVENTORY_STOCK_MOVEMENT_RECORDED: 'inventory.stock-movement.recorded',
  // `inventory.stock.commit-sale` → `CommitSaleUseCase` (RPC, Retail ship flow →
  // Inventory): physically ships an order's allocated stock at fulfillment time —
  // per line it decrements BOTH `quantity_on_hand` and `quantity_allocated` in one
  // `StockLevel.commitSale` and appends one strictly-negative `sale` movement
  // referencing the fulfillment. All-lines-atomic + idempotent on `fulfillmentId`
  // (ADR-031). `inventory.stock.committed` is the past-tense reserved-surface event
  // it emits per committed line onto `inventory_queue` (no consumer yet — the
  // `inventory.stock.{reserved,allocated,released}` precedent).
  INVENTORY_STOCK_COMMIT_SALE: 'inventory.stock.commit-sale',
  INVENTORY_STOCK_COMMITTED: 'inventory.stock.committed',
  // `inventory.stock.restock-from-return` → `RestockFromReturnUseCase` (RPC, Retail
  // Inspect & Disposition flow → Inventory): physically returns a return request's
  // `restock`-disposition stock to sellable inventory — per line it increments
  // `quantity_on_hand` (one `StockLevel.changeOnHand(+quantity)`) and appends one
  // strictly-positive `return` movement referencing the return request. All-lines-
  // atomic + idempotent on `returnRequestId` (ADR-032). `inventory.stock.returned`
  // is the past-tense reserved-surface event it emits per restocked line onto
  // `inventory_queue` (no consumer yet — the typed alias for the `return`-type
  // movement, exposed as its own key for downstream filtering; the
  // `inventory.stock.{allocated,committed}` precedent).
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
  // Category RPC command + read keys (API Gateway → Catalog on `catalog_queue`).
  // Each is served by a `@MessagePattern` handler on the catalog category
  // controller:
  // `catalog.category.create` → `CreateCategoryUseCase` → `CategoryView`,
  // `catalog.category.reparent` → `ReparentCategoryUseCase` → `CategoryReparentView`,
  // `catalog.category.list` → `ListCategoriesUseCase` → `CategoryView[]`,
  // `catalog.category.get-tree` → `GetCategoryTreeUseCase` → `CategoryTreeNodeView`,
  // `catalog.category.list-products` → `ListCategoryProductsUseCase` → `IPage<ProductWithVariantsView>`.
  // `catalog.product.reclassify` is a `product.*` key but is served by the SAME
  // category controller (the operation's subject is the category membership, not
  // the product header) → `ReclassifyProductUseCase` → `ProductCategoriesView` —
  // the `retail.cart.place`-served-by-orders-controller precedent.
  // The category capability emits NO events — list/tree/browse are reads and
  // reclassify is a navigation reshape with no cross-service consumer today, so
  // there are no past-tense `catalog.category.*` surfaces to pair with these
  // commands (ADR-029 §6).
  CATALOG_CATEGORY_CREATE: 'catalog.category.create',
  CATALOG_CATEGORY_REPARENT: 'catalog.category.reparent',
  CATALOG_CATEGORY_LIST: 'catalog.category.list',
  CATALOG_CATEGORY_GET_TREE: 'catalog.category.get-tree',
  CATALOG_CATEGORY_LIST_PRODUCTS: 'catalog.category.list-products',
  CATALOG_PRODUCT_RECLASSIFY: 'catalog.product.reclassify',
  // Media RPC command + read keys (API Gateway → Catalog on `catalog_queue`).
  // Each is served by a `@MessagePattern` handler on the catalog media controller:
  // `catalog.media.attach` → `AttachMediaUseCase` → `MediaAssetView`,
  // `catalog.media.reorder` → `ReorderMediaUseCase` → `MediaAssetView[]`,
  // `catalog.media.detach` → `DetachMediaUseCase` → `MediaAssetView`,
  // `catalog.media.list` → `ListMediaUseCase` → `MediaAssetView[]`.
  // Like the category surface, the media capability emits NO events — attach /
  // reorder / detach are state changes with no cross-service consumer today and
  // list is a read, so there are no past-tense `catalog.media.*` surfaces to pair
  // with these commands (ADR-029 §6).
  CATALOG_MEDIA_ATTACH: 'catalog.media.attach',
  CATALOG_MEDIA_REORDER: 'catalog.media.reorder',
  CATALOG_MEDIA_DETACH: 'catalog.media.detach',
  CATALOG_MEDIA_LIST: 'catalog.media.list',
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
  // Order read + capture RPC keys (API Gateway → Retail, served by the orders
  // controller). `retail.order.get` resolves one `OrderView` (owner-checked, or a
  // staff `order:read` override); `retail.order.list` resolves an `IPage<OrderView>`
  // of the caller's own orders; `retail.payment.capture` walks the order's authorized
  // payment to `captured` (owner-checked, or a staff `order:capture` override) and
  // resolves the updated `OrderView` (ADR-028 §3/§7).
  RETAIL_ORDER_GET: 'retail.order.get',
  RETAIL_ORDER_LIST: 'retail.order.list',
  RETAIL_PAYMENT_CAPTURE: 'retail.payment.capture',
  // Fulfillment RPC command keys (API Gateway → Retail, served by the orders
  // controller — a fulfillment is a sibling aggregate in the orders module, ADR-031).
  // `retail.fulfillment.create` → `CreateFulfillmentUseCase` plans a shipment (one or
  // more `OrderLine` quantities, owner-or-staff `order:fulfill`) and resolves a
  // `FulfillmentView`; `retail.fulfillment.list` → `ListFulfillmentsUseCase` resolves
  // an order's `FulfillmentView[]` newest-first (owner-or-staff `order:read`). The
  // `fulfillment.*` aggregate noun is distinct from the order/payment keys.
  RETAIL_FULFILLMENT_CREATE: 'retail.fulfillment.create',
  RETAIL_FULFILLMENT_LIST: 'retail.fulfillment.list',
  // `retail.fulfillment.ship` → `ShipFulfillmentUseCase` ships a pending fulfillment
  // (owner-or-staff `order:fulfill`): it captures an authorized payment inline,
  // advances the fulfillment → `shipped`, the order's fulfillment axis + the shipped
  // `OrderLine` statuses, then calls `inventory.stock.commit-sale` after the local
  // commit, and resolves the updated `FulfillmentView` (ADR-031).
  RETAIL_FULFILLMENT_SHIP: 'retail.fulfillment.ship',
  // `retail.fulfillment.deliver` → `MarkDeliveredUseCase` marks a `shipped`
  // fulfillment `delivered` (owner-or-staff `order:fulfill`); once every non-cancelled
  // fulfillment of the order is delivered it advances the order's lifecycle +
  // fulfillment axes to `delivered` too (the happy-path terminal, ADR-031). Resolves
  // the updated `FulfillmentView`.
  RETAIL_FULFILLMENT_DELIVER: 'retail.fulfillment.deliver',
  // Order-cancellation RPC keys (API Gateway → Retail, served by the orders
  // controller). `retail.order.cancel` → `CancelOrderUseCase` cancels a not-yet-shipped
  // order (owner-or-staff `order:cancel`): it rejects an order with a `shipped`/
  // `delivered` fulfillment, cancels any `pending` fulfillments, voids an authorized
  // payment / flags a captured one for refund, and releases the order's stock
  // allocation via `inventory.allocation.cancel` (ADR-031). `retail.order.cancel-line`
  // → `CancelLineUseCase` cancels the unshipped quantity of a single `OrderLine` (staff
  // `order:cancel`) with a proportional allocation release. Both resolve an `OrderView`.
  RETAIL_ORDER_CANCEL: 'retail.order.cancel',
  RETAIL_ORDER_CANCEL_LINE: 'retail.order.cancel-line',
  // Return (RMA) RPC command + read keys (API Gateway → Retail, served by the returns
  // controller — the returns bounded context is its own module, ADR-032). Each is the
  // imperative command for one RMA lifecycle transition (the `catalog.variant.create`/
  // `.created` split, ADR-008):
  // `retail.return.open` → `OpenReturnRequestUseCase` (owner-or-staff; runs the return
  // window + returnable-quantity checks and finalizes an `RMA-<year>-…` number) →
  // `ReturnRequestView`; `retail.return.authorize`/`.reject`/`.receive`/`.close` walk the
  // status machine (staff `order:return-authorize` for authorize/reject/close, warehouse
  // `inventory:receive-return` for receive); `retail.return.get` resolves one
  // `ReturnRequestView` (owner-or-staff `order:read`); `retail.return.list` resolves an
  // order's `ReturnRequestView[]` newest-first (owner-or-staff `order:read`).
  // `retail.return.inspect` is the warehouse condition/disposition step
  // (`inventory:receive-return`): it records each line's outcome, walks the RMA
  // `received -> inspected`, and triggers the cross-service restock for `restock`-
  // disposition lines via `inventory.stock.restock-from-return` (ADR-032).
  RETAIL_RETURN_OPEN: 'retail.return.open',
  RETAIL_RETURN_AUTHORIZE: 'retail.return.authorize',
  RETAIL_RETURN_REJECT: 'retail.return.reject',
  RETAIL_RETURN_RECEIVE: 'retail.return.receive',
  RETAIL_RETURN_INSPECT: 'retail.return.inspect',
  RETAIL_RETURN_CLOSE: 'retail.return.close',
  RETAIL_RETURN_GET: 'retail.return.get',
  RETAIL_RETURN_LIST: 'retail.return.list',
  // Refund RPC command + read keys (API Gateway → Retail, served by the orders
  // controller — `Refund` is a sibling aggregate in the orders module, ADR-032).
  // `retail.refund.issue` → `IssueRefundUseCase` issues a refund against a captured
  // payment (staff `order:refund`): it validates the refundable ceiling, calls the
  // payment gateway, writes a `refund` row, accumulates `payment.refunded_amount_minor`
  // (flipping the payment to `refunded` on a full refund), audits the money movement,
  // and resolves a `RefundView`. `retail.refund.list` → `ListRefundsForOrderUseCase`
  // resolves an order's `RefundView[]` newest-first (owner-or-staff `order:read`). The
  // auto-refund-from-cancel consumer calls `IssueRefundUseCase` directly (not over RMQ).
  RETAIL_REFUND_ISSUE: 'retail.refund.issue',
  RETAIL_REFUND_LIST: 'retail.refund.list',
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
  // `retail.payment.captured` — emitted onto `retail_queue` after an explicit
  // capture succeeds. A reserved surface today, like `retail.payment.authorized`.
  RETAIL_PAYMENT_CAPTURED: 'retail.payment.captured',
  // `retail.fulfillment.created` — emitted onto `retail_queue` (the producer's own
  // queue) after a shipment is planned. The past-tense event paired with the
  // imperative `retail.fulfillment.create` command (the `catalog.variant.create`/
  // `.created` split, ADR-008). A reserved surface today, like the four
  // `retail.cart.*` events.
  RETAIL_FULFILLMENT_CREATED: 'retail.fulfillment.created',
  // `retail.fulfillment.shipped` — emitted onto `retail_queue` (the producer's own
  // queue) after a shipment ships. The past-tense event paired with the imperative
  // `retail.fulfillment.ship` command. The notification service binds a consumer for
  // it (a shipment-confirmation fan-out); for now the emit is best-effort post-commit
  // (ADR-020).
  RETAIL_FULFILLMENT_SHIPPED: 'retail.fulfillment.shipped',
  // `retail.fulfillment.delivered` — emitted onto `retail_queue` (the producer's own
  // queue) after a shipment is marked delivered. The past-tense event paired with the
  // imperative `retail.fulfillment.deliver` command. A reserved surface today (no
  // consumer bound yet), like `retail.fulfillment.created`.
  RETAIL_FULFILLMENT_DELIVERED: 'retail.fulfillment.delivered',
  // `retail.order.cancelled` — emitted onto `retail_queue` (the producer's own queue)
  // after an order is cancelled. It carries `paymentFlaggedForRefund` so a downstream
  // consumer can tell a captured-and-flagged cancellation (a refund is owed) from a
  // simple voided-authorization one. NOTE: this key was *retired* by ADR-028 with the
  // old order model; it is **re-introduced fresh here** with a live producer (Cancel
  // Order), not resurrected from any stub. A reserved surface today (no consumer yet).
  RETAIL_ORDER_CANCELLED: 'retail.order.cancelled',
  // Return (RMA) lifecycle events — the past-tense surfaces paired with the imperative
  // `retail.return.*` commands (ADR-032). Two destinations by the
  // producer-targets-consumer-queue pattern (ADR-008/020): `retail.return.requested` /
  // `.authorized` / `.received` are the buyer-facing ones, emitted onto
  // `notification_events` (the notification service's own queue — it binds a returns
  // fan-out consumer for them); `retail.return.rejected` / `.closed` are emitted onto
  // `retail_queue` (the producer's own queue — reserved surfaces today, no consumer).
  // `retail.return.inspected` is the buyer-facing past-tense of `retail.return.inspect`,
  // emitted onto `notification_events` (the notification service binds a returns consumer
  // for it); it carries `restockedLineCount` so a downstream can tell how many lines went
  // back to stock (ADR-032).
  RETAIL_RETURN_REQUESTED: 'retail.return.requested',
  RETAIL_RETURN_AUTHORIZED: 'retail.return.authorized',
  RETAIL_RETURN_REJECTED: 'retail.return.rejected',
  RETAIL_RETURN_RECEIVED: 'retail.return.received',
  RETAIL_RETURN_INSPECTED: 'retail.return.inspected',
  RETAIL_RETURN_CLOSED: 'retail.return.closed',
  // Refund lifecycle events — the past-tense surfaces paired with the imperative
  // `retail.refund.issue` command (ADR-032). Two destinations by the
  // producer-targets-consumer-queue pattern (ADR-008/020): `retail.refund.issued` is the
  // buyer-facing success event, emitted onto `notification_events` (the notification
  // service binds a refund fan-out consumer for it); `retail.refund.failed` is emitted
  // onto `retail_queue` (the producer's own queue — a reserved surface today, no
  // consumer; modeled for a real gateway decline, unreachable with the always-succeed
  // fake).
  RETAIL_REFUND_ISSUED: 'retail.refund.issued',
  RETAIL_REFUND_FAILED: 'retail.refund.failed',
  NOTIFICATION_HEALTH_PING: 'notification.health.ping',
  // Notification template authoring RPCs (Gateway → Notification, on
  // `notification_events`) — the notification service's first non-health
  // `@MessagePattern` surface (ADR-033). `author` is create-or-edit (append a new
  // `version`); `set-active` activates/deactivates one version by id; `list` is the
  // filtered registry browse.
  NOTIFICATION_TEMPLATE_AUTHOR: 'notification.template.author',
  NOTIFICATION_TEMPLATE_SET_ACTIVE: 'notification.template.set-active',
  NOTIFICATION_TEMPLATE_LIST: 'notification.template.list',
  // Notification delivery audit reads + the record-outcome RPC (Gateway →
  // Notification, on `notification_events`). `list` is the paginated, filterable
  // audit query; `get` loads one full delivery row by id; `record-outcome` is the
  // ESP-webhook seam that flips a `sent` delivery to `delivered`/`bounced` (the
  // webhook ingestion itself is a documented stub — RPC-only, no gateway route in
  // this capability, ADR-033).
  NOTIFICATION_DELIVERY_LIST: 'notification.delivery.list',
  NOTIFICATION_DELIVERY_GET: 'notification.delivery.get',
  NOTIFICATION_DELIVERY_RECORD_OUTCOME: 'notification.delivery.record-outcome',
  // `notification.delivery.retry` → `RetryDeliveryUseCase` (RPC, Gateway →
  // Notification, on `notification_events`): the operator manual-retry of one `failed`
  // delivery — re-dispatches the already-rendered body/subject via `NOTIFIER`, flips
  // the row `sent`/`failed`, and (at the attempt cap) emits the failure event. A manual
  // retry forces past the backoff gate the scheduled sweeper honors (ADR-033).
  NOTIFICATION_DELIVERY_RETRY: 'notification.delivery.retry',
  // `notifications.delivery.failed` — the producer event emitted onto the notification
  // service's own `notification_events` queue when a delivery exhausts its
  // `MAX_DELIVERY_ATTEMPTS` budget and stays `failed`. A reserved surface today (no
  // consumer): the downstream-alerting seam a future ops-alert / dead-letter capability
  // binds (ADR-033). The plural `notifications.*` prefix marks it as the cross-cutting
  // alerting stream, distinct from the singular `notification.delivery.*` RPC commands.
  NOTIFICATIONS_DELIVERY_FAILED: 'notifications.delivery.failed',
} as const;

export type RoutingKey = (typeof ROUTING_KEYS)[keyof typeof ROUTING_KEYS];
