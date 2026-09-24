# Wire contracts

What the payloads, views and enums in `libs/contracts` mean on the wire, where the TypeScript type
says less than the code does: units, time formats, what `null` means, who fills a field, which
values are never produced, and which fields deliberately carry no personal data. Routing keys and
which service consumes which event are in [`README.md` §2](../../README.md#2-architecture-at-a-glance);
HTTP routes and the error contract are in [§6](../../README.md#6-http-api). Rationale lives in
[ADR-005](../adr/005-split-shared-common-into-bounded-libs.md) and [ADR-017](../adr/017-architecture-lint-via-eslint-boundaries.md) (why
the contracts are a framework-free library), [ADR-008](../adr/008-rabbitmq-via-libs-messaging.md)
(the wire format) and [ADR-035](../adr/035-event-store-firehose-topic-exchange.md) (the firehose).

## Conventions across every context

- **Every timestamp is an ISO-8601 string** produced by `Date.prototype.toISOString()`, so it is
  UTC with a `Z`. The single field typed `Date` is `StockLevelView.updatedAt`
  (`libs/contracts/inventory/stock/stock-level.view.ts`); it crosses RabbitMQ and the Redis stock
  cache as JSON, so every consumer receives it as a string too.
- **Every `*Minor` field is an integer count of minor units** of the row's currency. No contract
  carries a float amount.
- **Every event payload carries `eventVersion: 'v1'`** (`catalog.price.scheduled` inherits it from
  `ICatalogPriceChangedEvent`).
- **Pagination has two request vocabularies and one response shape.** Every paged response is
  `{ items, total, page, size }`, `page` 1-based. The request side differs, and so does who enforces
  the ceiling:

  | RPC                                                      | Request fields     | Defaults and ceiling                                                                                                                      |
  | -------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
  | `catalog.product.list`, `catalog.category.list-products` | `page`, `pageSize` | `clampPageWindow` in the use case: `1` / `20`, capped at `100`                                                                            |
  | `notification.delivery.list`                             | `page`, `pageSize` | `clampPageWindow` in `ListDeliveriesUseCase`                                                                                              |
  | `audit.event.query`, `audit.entry.query`                 | `page`, `pageSize` | `clampPageWindow` in `QueryDomainEventsUseCase` / `QueryAuditLogEntriesUseCase`                                                           |
  | `inventory.stock-movement.list`                          | `page`, **`size`** | **none in inventory** — `ListStockMovementsUseCase` passes both through; only the gateway's `MovementsQueryDto` (`@Max(100)`) bounds them |

  (`libs/common/pagination/clamp-page-window.ts`, `clampPageWindow`). A caller on RabbitMQ that skips
  the gateway gets no page-size ceiling on the stock-movement list.

## Audit and event store

Payloads and views of the three `audit.*` RPCs and the `audit.staff.action` stream
([ADR-039](../adr/039-audit-and-event-store-query-surface.md)).

### `audit.staff.action`

`toAuditStaffActionEvent` (`libs/contracts/auth/audit-staff-action.event.ts`) is the one mapping
from the in-process `IAuditLogEvent` to the wire, shared by both `AUDIT_LOG_PUBLISHER` bindings
(gateway `auth`, retail `orders`):

- `actorType` is `staff-user` only when the caller passed `actorKind: 'staff'`; `customer` and
  `anonymous` both become `system`. `actorType` is therefore an origin class, not "was a person
  involved". `IssueRefundUseCase.writeAudit` passes `actorKind: 'staff'` on the auto-refund path
  too, so a refund issued by `OrderCancelledConsumer` is stored as `staff-user` with a `null`
  `actorId`
  (`apps/retail-microservice/src/modules/orders/application/use-cases/issue-refund.use-case.ts`).
- `action` is `IAuditLogEvent.name`, the event name (`README.md` §6 explains the consequence for
  `?action=`).
- `before` is `payload.before` when the call site supplied one, else `null`. `after` is
  `payload.after` when supplied, else **the whole payload**. A call site that passes neither key
  (the refund audit is one) produces `before: null` and an `after` that is a payload, not a state.
- `ipAddress` is hard-coded `null`; no call site captures a request IP.
- `correlationId` falls back to `''` when the event had none, because
  `ICorrelationPayload.correlationId` is a non-nullable `string`. `IngestAuditLogUseCase.execute`
  coalesces a missing one to `''` again, so every row the ingest writes has a string
  `audit_log_entry.correlation_id`, even though the column and `AuditLogEntryView.correlationId`
  are nullable
  (`apps/event-store-microservice/src/modules/audit-and-events/application/use-cases/ingest-audit-log.use-case.ts`).
  The gateway rejects an empty `correlationId` filter (`@IsNotEmpty()` on the audit query DTOs), so
  a row written without a correlation id is unreachable by correlation id over HTTP.

### Queries

- The two query payloads nest their filters under `filters` (`IDomainEventQueryPayload`,
  `IAuditLogQueryPayload`, `libs/contracts/audit/`). The top-level `correlationId` inherited from
  `ICorrelationPayload` is the trace id of the request asking; `filters.correlationId` is the id
  being searched for. `ICorrelationTracePayload` names the searched-for id `targetCorrelationId`
  for the same reason.
- `from` / `to` bound `occurredAt` inclusively (`Between` / `MoreThanOrEqual` / `LessThanOrEqual`
  in `DomainEventTypeormRepository.query` and `AuditLogEntryTypeormRepository.query`).
- Query results are ordered `occurredAt DESC, id DESC`; each timeline of an
  `ICorrelationTraceResult` is ordered `occurredAt ASC, id ASC`, so rows sharing a millisecond
  keep insertion order (`listByCorrelationId` in the same two repositories).
- `DomainEventView.payload`, `AuditLogEntryView.before` / `after` are returned verbatim as stored.

## Auth and customer privacy

- `PermissionCodeEnum` values match `^[a-z][a-z-]*:[a-z][a-z-]*$`; `PermissionAggregate` rejects any
  other code (`apps/api-gateway/src/modules/auth/domain/permission.aggregate.ts`,
  `PERMISSION_CODE_REGEX`).
- `ConsentRecordView.updatedAt` is `null` when the customer has no stored `consent_record` row;
  the flags are then the defaults (`README.md` §5).
- `customer.consent.updated` carries the full consent snapshot, not only the customer id: the
  notification consent cache refreshes itself from the event
  (`apps/notification-microservice/src/modules/notifications/infrastructure/consumers/consent-events.consumer.ts`).
  Its `updatedAt` is the stored row's `updated_at`, or the emit instant when the read-back has none
  (`apps/api-gateway/src/modules/auth/infrastructure/messaging/customer-events.rabbitmq.publisher.ts`,
  `CustomerEventsRabbitmqPublisher.publishConsentUpdated`).
- **`customer.erased` carries no personal data**: `customerId`, `erasedAt`, `actorStaffUserId` and
  the envelope ([ADR-037](../adr/037-consent-record-and-tombstone-erasure.md)). `actorStaffUserId`
  is nullable in the type, but its only producer is the admin erase route, which always passes the
  staff caller (`apps/api-gateway/src/modules/customer-admin/presentation/customer-admin.controller.ts`).

## Catalog and pricing

### Products and variants

- `ProductView.publishedAt` / `archivedAt` appear only on the response of the operation that made
  the transition (`PublishProductUseCase`, `ArchiveProductUseCase`). The product row stores no such
  timestamp, so no read returns them; the same instant rides `catalog.product.published` /
  `.archived` as both the business field and `occurredAt`.
- `ProductView.warnings` is set only by publish, and only when there is a warning; it is otherwise
  absent, never `[]` (`PublishProductUseCase.execute`). Its one code,
  `CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA`, is a plain constant in
  `libs/contracts/catalog/dto/publish-warning.view.ts`, not a `CatalogErrorCodeEnum` member —
  nothing throws it.
- `catalog.product.list` ignores `IListProductsQuery.status`: `ListProductsUseCase` always reads
  the active catalogue (`repository.listActive`).
- `catalog.product.get` resolves a slug in **any** status, draft included, and the gateway route
  in front of it is public (`GetProductBySlugUseCase`). Its `variants`, like every
  `ProductWithVariantsView`, holds the active variants only (`toProductWithVariantsView`).
- `catalog.variant.get` applies no status filter to the variant or its product
  (`GetVariantUseCase`), so an order or stock row keyed on an archived variant still resolves.
- `IRegisterProductPayload.description` defaults to `''`
  (`apps/catalog-microservice/src/modules/catalog/domain/product.model.ts`, `Product`).
- `catalog.product.publish` requires a `draft` product with at least one variant, and archive
  requires an `active` one (`Product.publish`, `Product.archive`).

### Categories and media

- `CategoryView.path` is the slug chain from the root, `/<root>/…/<slug>`; a root is `/<slug>`
  (`Category.derivePath`). `sortOrder` defaults to `0` (`Category.create`).
- `ICreateCategoryPayload.parentSlug` and `IReparentCategoryPayload.newParentSlug` address the
  parent by slug. An omitted `parentSlug`, or a `null` / omitted `newParentSlug`, makes the
  category a root (`CreateCategoryUseCase`, `ReparentCategoryUseCase`).
- `catalog.category.get-tree` and `catalog.category.list-products` answer `CATEGORY_NOT_FOUND` for
  an archived category as well as a missing one. Tree nodes are sorted by `sortOrder`, then `name`;
  a leaf has `children: []` (`GetCategoryTreeUseCase`, `assembleCategoryTree`).
- `CategoryReparentView.rewrittenDescendantCount` is the row count of the descendant-path rebase,
  `0` for a leaf (`CategoryTypeormRepository.reparentSubtree`).
- `ProductCategoriesView.categories` is the membership re-read after the change, not a diff.

### Prices and tax categories

- `catalog.price.set` is both Set and Schedule. An omitted `validFrom` is now; a `validFrom`
  before now is `PRICE_VALID_FROM_IN_PAST`; `priority` defaults to `0` (`Price.set`,
  `apps/catalog-microservice/src/modules/pricing/domain/price.model.ts`).
- A new price must start strictly after the open price of the same `(variantId, currency)`: the
  open row is closed at the new `validFrom`, and a new price starting at or before the open one's
  start is `PRICE_SCHEDULE_CONFLICT` — there is no reschedule (`SetPriceUseCase.resolvePredecessor`).
- `catalog.price.changed` is published when the new price's `validFrom` is at or before now,
  `catalog.price.scheduled` when it is later; never both. `effectiveAt` on the scheduled event equals
  `validFrom` (`SetPriceUseCase.publish`).
- `IPriceQuery.asOf` omitted means now (`ListPricesUseCase`, `SelectApplicablePriceUseCase`).
  `currency` is required on the wire; the gateway fills an omitted one from
  `CATALOG_GATEWAY_DEFAULT_CURRENCY` (`GetApplicablePriceUseCase`, `ListPricesUseCase` in
  `apps/api-gateway/src/modules/catalog/application/use-cases/`).
- `PriceView.validTo` is `null` for the open-ended row.
- `TaxCategory.code` must match `^[A-Z][A-Z0-9_]*$`
  (`apps/catalog-microservice/src/modules/pricing/domain/tax-category.model.ts`).
  `VariantTaxHeaderView.taxCategoryId` / `taxCategoryCode` are both `null` for an unclassified
  variant.

## Health

`ServiceHealthStatus` (`libs/contracts/health/health.view.ts`) is set by
`HealthRabbitmqAdapter` (`apps/api-gateway/src/modules/health/infrastructure/messaging/health-rabbitmq.adapter.ts`):
`ok` with `latencyMs` on a reply, `timeout` on an RxJS `TimeoutError` after
`HEALTH_PROBE_TIMEOUT_MS`, and `error` for **any other** failure — a rejected RPC or a transport
error alike. `latencyMs` is present only on `ok`. The rest is in `README.md` §6.

## Inventory

### Movements

`StockMovementView.quantity` is signed by type ([ADR-030](../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)).
`referenceType` / `referenceId` are plain strings with no foreign key; the values each writer uses:

| Writer (`apps/inventory-microservice/src/modules/stock/application/use-cases/`) | `type`           | `referenceType`  | `reasonCode`                      |
| ------------------------------------------------------------------------------- | ---------------- | ---------------- | --------------------------------- |
| `ReceiveStockUseCase`                                                           | `receipt`        | `null`           | `null`                            |
| `AdjustStockUseCase`                                                            | `adjustment`     | `null`           | the caller's `reasonCode`         |
| `TransferStockUseCase`                                                          | `adjustment` × 2 | `transfer`       | `transfer-out` / `transfer-in`    |
| `AllocateStockUseCase`                                                          | `allocation`     | `order`          | —                                 |
| `CancelAllocationUseCase`                                                       | `release`        | `order`          | `IAllocationCancelPayload.reason` |
| `ReleaseReservationUseCase`, `SweepExpiredReservationsUseCase`                  | `release`        | `cart`           | the release reason                |
| `CommitSaleUseCase`                                                             | `sale`           | `fulfillment`    | —                                 |
| `RestockFromReturnUseCase`                                                      | `return`         | `return-request` | —                                 |

The two legs of a transfer share one `referenceId`, so `(referenceType, referenceId)` is not unique
for a transfer. Reserve writes no movement.

### Events

- `inventory.stock-movement.recorded` is published once per appended movement, after the commit,
  by every writer in the table above (`emitMovementRecorded`, `movement-recorded.emitter.ts`). Reserve
  appends nothing and so emits none.
- `inventory.stock.low` is raised by `maybeEmitLowStock` (`low-stock.emitter.ts`) after an on-hand
  **decrease** — Adjust with a negative delta, the source leg of a Transfer, Commit Sale — whose
  resulting `quantityOnHand` is at or below `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD` (`5`). It measures
  on-hand, not `available`: reserving or allocating the last units raises nothing, and every
  further decrease below the threshold raises it again. `quantity` is the post-commit on-hand.
- `inventory.stock.released` has three producers. Release and the sweep publish the reservation's
  own `reservationId` and `cartId`, with `reason` from the payload (default `cart-removed`;
  the gateway's manual route sends `manual`) or `expired`. Cancel Allocation publishes both as
  `null` and `reason: 'order-cancelled'` whatever `IAllocationCancelPayload.reason` was
  (`CancelAllocationUseCase.emitReleased`).
- `inventory.stock.allocated` and `IAllocationResultEntry` carry `reservationId: null` when a line
  was allocated directly from `available` because the cart held nothing for it.

### Multi-line commands

- An omitted `stockLocationId` on an allocate, cancel-allocation or commit-sale line is
  `INVENTORY_DEFAULT_STOCK_LOCATION` (`'default-warehouse'`); a restock line must name its
  location. Every line's `quantity` must be a positive integer and `lines` must be non-empty
  (`normalizeReservationLines`, `reservation-mutation.ts`).
- **Commit Sale and Restock From Return reject two lines on the same `(variantId, stockLocationId)`**
  (`requireDistinctLevels`): their replay guard is a UNIQUE on that pair per reference, so a
  duplicate would read as a replay. Allocate and Cancel Allocation accept such lines and sum them.
- Commit Sale and Restock From Return are all-lines-atomic and idempotent on `fulfillmentId` /
  `returnRequestId` (`README.md` §4). On a replay the result **echoes the request's lines** without
  touching a counter; it is not read back from the ledger (`CommitSaleUseCase.execute`,
  `RestockFromReturnUseCase.execute`).
- `IAllocationCancelPayload.operationKey` is minted once per logical cancellation by the caller
  ([ADR-057](../adr/057-cancel-allocation-needs-an-operation-identity.md)).

### Reads

- `inventory.reservation.release` with `reservationId` rejects an unknown row
  (`RESERVATION_NOT_FOUND`) and a non-active one (`RESERVATION_INVALID_STATE`); with `cartId` it
  releases every matching active hold and returns `{ released: [] }` when there is none
  (`ReleaseReservationUseCase.execute`).
- `IStockMovementListPayload.from` / `to` bound `occurredAt` inclusively. An unparseable value is
  dropped silently rather than rejected (`ListStockMovementsUseCase.parseInstant`); the gateway DTO
  is the only validation.

## Notifications

- A delivery's `eventReferenceType` / `eventReferenceId` pair, as the consumers write it
  (`apps/notification-microservice/src/modules/notifications/infrastructure/consumers/`):

  | `eventReferenceType` | `eventReferenceId`              | Written for                                            |
  | -------------------- | ------------------------------- | ------------------------------------------------------ |
  | `order`              | `orderId`                       | `retail.order.placed`, `retail.order.cancelled`        |
  | `fulfillment`        | `fulfillmentId`                 | `retail.fulfillment.shipped` / `.delivered`            |
  | `refund`             | `refundId`                      | `retail.refund.issued`                                 |
  | `return-request`     | `rmaId`                         | the four buyer-facing `retail.return.*` events         |
  | `stock-low`          | `<variantId>:<stockLocationId>` | `inventory.stock.low`                                  |
  | `marketing`          | `campaignId`                    | `notification.marketing.send` (`SendMarketingUseCase`) |

- `delivered` and `bounced` are written only by `notification.delivery.record-outcome`, which no
  gateway route and no bridge calls, so a delivery list filtered on either status is always empty
  today.
- `NotificationTemplateView.subject` is `null` for `sms` and `push`.

## Retail — cart

- `IRetailCartCreatePayload.currency` omitted means the `DEFAULT_CURRENCY` value, through
  `RETAIL_DEFAULT_CURRENCY` (`apps/retail-microservice/src/modules/cart/cart.module.ts`,
  `CreateCartUseCase.execute`).
- `retail.cart.add-line` on a variant already in the cart increases that line, and the line keeps
  its **first** price snapshot. `retail.cart.line-added` is raised either way, with `quantity`
  equal to the amount added, not the new total (`Cart.addLine`,
  `apps/retail-microservice/src/modules/cart/domain/cart.model.ts`).
- `CartStatusEnum.CONVERTED` and `ABANDONED` are never set through the `Cart` aggregate. Place
  converts with `UPDATE cart SET status = 'converted' … WHERE … status = 'active'`
  (`CartReaderTypeormAdapter.markConverted`); the only thing that abandons a cart is customer
  erasure (`CustomerErasureWriterAdapter`,
  `apps/api-gateway/src/modules/auth/infrastructure/persistence/customer-erasure-writer.adapter.ts`).
  Nothing abandons a cart on a timer.

## Retail — orders, payments, fulfillments, refunds

### Status values nothing produces

Assignments in `apps/retail-microservice/src/modules/orders/domain/` and the use cases:

| Enum                     | Values that are produced                                       | Values nothing sets                                               |
| ------------------------ | -------------------------------------------------------------- | ----------------------------------------------------------------- |
| `OrderStatusEnum`        | `pending` (place), `cancelled`, `delivered`                    | `confirmed`, `shipped` — shipment progress is `fulfillmentStatus` |
| `OrderPaymentStatusEnum` | `none`, `authorized`, `captured`, `failed` (declined at place) | `refunded` — a refund changes the `Payment`, not this axis        |
| `OrderLineStatusEnum`    | `allocated`, `shipped`, `partially-shipped`, `cancelled`       | `returned`                                                        |
| `PaymentStatusEnum`      | `authorized`, `capturing`, `captured`, `voided`, `refunded`    | `failed` — a declined capture returns the row to `authorized`     |
| `AddressOwnerTypeEnum`   | `order`                                                        | `customer`                                                        |

`confirmed` is still accepted as an input state by Cancel Order and Create Fulfillment. An order
refunded in full keeps `paymentStatus: 'captured'`; read its refunds instead. An `order_line`
becomes `cancelled` only when its whole quantity is cancelled (`OrderLine`, `activeQuantity === 0`);
a partly cancelled line keeps its status. `RefundStatusEnum.FAILED` and `retail.refund.failed` are
reachable only through a gateway decline, which the bound `FakePaymentGatewayAdapter` never returns.

### Money and totals

- `OrderLineView.lineTotalMinor = unitPriceMinor × quantity + taxAmountMinor − discountAmountMinor`
  and `OrderView.grandTotalMinor = subtotalMinor + taxTotalMinor + shippingTotalMinor − discountTotalMinor`
  (`OrderLine`, `Order`). Place writes every tax, discount and shipping amount as `0`
  (`PlaceOrderUseCase`), so `grandTotalMinor = subtotalMinor = Σ unitPriceMinor × quantity`.
- The totals are the place-time snapshot. Cancel Line changes `cancelledQuantity` and no total.
- `IRetailPaymentCapturePayload.amountMinor` is not a partial capture: any value other than the
  order's `grandTotalMinor` is `PARTIAL_CAPTURE_UNSUPPORTED`, and an omitted one captures the whole
  (`CapturePaymentUseCase.execute`). A capture under a new key of a payment that is already
  `captured` returns the current `OrderView` and charges nothing.
- A `refund` row is written `pending` **before** the gateway call and moves to `issued` or `failed`
  after it (`IssueRefundUseCase`), so a crash between the two leaves a `pending` row with a `null`
  `gatewayReference` and `issuedAt`. `retail.refund.issued.amountMinor` is that one refund's amount.

### Idempotent writes

The four `Idempotency-Key` writes ([ADR-036](../adr/036-idempotency-key-store-and-enforced-occ.md),
`README.md` §5) fingerprint these fields and nothing else:

| RPC                       | Fingerprinted body (`canonicalBody`)                           | Use case                 |
| ------------------------- | -------------------------------------------------------------- | ------------------------ |
| `retail.cart.place`       | `cartId`, `shippingAddress`, `billingAddress`, `paymentMethod` | `PlaceOrderUseCase`      |
| `retail.payment.capture`  | `orderId`, `amountMinor`                                       | `CapturePaymentUseCase`  |
| `retail.fulfillment.ship` | `orderId`, `fulfillmentId`, `trackingNumber`, `carrier`        | `ShipFulfillmentUseCase` |
| `retail.refund.issue`     | `orderId`, `paymentId`, `amountMinor`, `reason`                | `IssueRefundUseCase`     |

`idempotencyKey` is optional in each payload type and required by each use case. Place has a second
guard that does not expire: placing a cart that is already `converted`, under any key, returns the
order found by `source_cart_id` (`PlaceOrderUseCase`, `orderRepository.findBySourceCartId`).

### Other payload rules

- `IAddressInput.country` is trimmed and upper-cased by `Address` before it is stored.
- `IRetailOrderCancelPayload.reason` reaches `retail.order.cancelled` only. The allocation release
  that follows is sent with `reason: 'order-cancelled'`, which is what lands on the `release`
  movement (`CancelOrderUseCase`).
- Cancel Order and Cancel Line release the allocation at `INVENTORY_DEFAULT_STOCK_LOCATION`.
- `IRetailOrderCancelLinePayload.isStaffCancel` is the gate itself: `false` is
  `ORDER_ACCESS_FORBIDDEN`. An omitted `quantity` cancels the line's whole remaining active
  quantity; more than that is `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING` (`CancelLineUseCase`).
- `retail.refund.list` and `retail.return.list` owner-check against the **order's** customer and
  answer `403` (`REFUND_ACCESS_FORBIDDEN` / `RETURN_ACCESS_FORBIDDEN`) to anyone else who is not
  staff, never an empty list (`ListRefundsForOrderUseCase`, `ListReturnsForOrderUseCase`,
  [ADR-051](../adr/051-refusing-a-resource-you-do-not-own.md)). `retail.return.get` checks the RMA's
  own `customerId` (`loadOwnedReturn`).
- `retail.fulfillment.delivered` is raised per fulfillment. The order becomes `delivered` once
  every fulfillment that is not `cancelled` is `delivered` (`MarkDeliveredUseCase`).

## Retail — returns

- `retail.return.inspected.restockedLineCount` counts the lines dispositioned `restock`. It is
  computed after the restock call, which is retry-then-log-for-replay, so it does not confirm that
  inventory applied them (`InspectAndDispositionUseCase.execute`).
- `inspectedAt` and `receivedAt` exist only on their events; the RMA row has no such columns.
- `closedAt` is stamped by both Reject and Close (`ReturnRequest`), so only `status` or the routing
  key tells a refusal from a settlement.
- `IRetailReturnInspectPayload.lineRefundAmountMinor` must be a non-negative integer (`ReturnLine`).
