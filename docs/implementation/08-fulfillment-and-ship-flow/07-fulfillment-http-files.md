# Fulfillment + cancel HTTP endpoints and `.http` files

This document explains the **gateway HTTP front** for the fulfillment-and-ship flow:
the six new routes under `/api/orders`, their authorization model, the port/adapter
extension that backs them, and the two Kulala `.http` files that exercise the whole
create → ship → deliver path and the cancel cases end-to-end.

It is the HTTP counterpart to the retail-side operations described in
[02-create-and-ship-fulfillment.md](02-create-and-ship-fulfillment.md),
[03-ship-triggered-capture-q5.md](03-ship-triggered-capture-q5.md), and
[05-cancel-order-and-line.md](05-cancel-order-and-line.md). Those documents explain
*what the retail microservice does*; this one explains *how a client reaches it over
HTTP*. The gateway module holds no order state — it is a thin port→adapter front that
translates HTTP into the retail RPCs ([ADR-009](../../adr/009-port-adapter-at-the-gateway.md)).

## 1. The six endpoints

All six routes live on the existing gateway `OrdersController`
(`apps/api-gateway/src/modules/orders/presentation/orders.controller.ts`,
`@Controller('orders')`), beside the pre-existing Read / List / Capture routes.

| Method | Path | Body | Auth | Result |
| --- | --- | --- | --- | --- |
| `POST` | `/api/orders/:orderId/fulfillments` | `{ stockLocationId?, lines: [{ orderLineId, quantity }] }` | staff `order:fulfill` | `FulfillmentView` `201` |
| `GET` | `/api/orders/:orderId/fulfillments` | — | owner **or** staff `order:read` | `FulfillmentView[]` |
| `POST` | `/api/orders/:orderId/fulfillments/:fulfillmentId/ship` | `{ trackingNumber?, carrier? }` + `Idempotency-Key` header | staff `order:fulfill` | `FulfillmentView` `200` |
| `POST` | `/api/orders/:orderId/fulfillments/:fulfillmentId/deliver` | — | staff `order:fulfill` | `FulfillmentView` `200` |
| `POST` | `/api/orders/:orderId/cancel` | `{ reason? }` | owner **or** staff `order:cancel` | `OrderView` `200` |
| `POST` | `/api/orders/:orderId/lines/:lineId/cancel` | `{ quantity? }` | staff `order:cancel` | `OrderView` `200` |

`orderId`, `fulfillmentId`, and `lineId` are all numeric (`BIGINT`) ids, parsed at the
edge with `ParseIntPipe`.

### Why two authorization shapes

The checkout chain authorizes a customer-reachable route by **authentication + an
ownership check in the retail use case, never a customer permission code** — customer
tokens carry no `permissions` claim, so a `@RequiresPermission(...)` gate would reject
the very customers it targets ([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md),
[ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) §7). A permission code
is therefore a **staff override** layered on top of the owner-check, not a gate on the
owner. The six routes split along whether a customer can ever legitimately invoke them:

- **Owner-or-staff** — **List fulfillments** and **Cancel Order**. A customer can list
  its own order's shipments and cancel its own *pending* order, so these carry **no
  `@RequiresPermission`**. The gateway use case resolves the staff override from
  `@CurrentUser().permissions` (`canReadAny` from `order:read`, `isStaffCancel` from
  `order:cancel`) and forwards it as a boolean; the retail use case is the single
  enforcement point — it allows the call if the override is set **or** the caller owns
  the order, else `403`.
- **Staff-only** — **Create / Ship / Deliver** fulfillment and **Cancel Line**. A
  customer cannot plan a shipment, ship it, mark it delivered, or cancel an individual
  line's unshipped quantity — these are warehouse/support operations. Rather than rely
  solely on the retail-side check, the routes are gated with
  `@RequiresPermission('order:fulfill')` / `@RequiresPermission('order:cancel')`
  directly. This is simpler and matches the operations' real shape; the gateway use
  case still resolves the staff flag from the same permissions (always `true` for a
  caller that passed the gate), so the retail use case remains the single source of
  truth and the wire contract is identical to the owner-or-staff routes.

This is the **recorded final choice** for the auth wiring: `@RequiresPermission` on
Create / Ship / Deliver / Cancel-Line; no `@RequiresPermission` on List fulfillments
(owner-or-`order:read`) and Cancel Order (owner-or-`order:cancel`). The seeded
`warehouse-staff` role carries `order:fulfill` + `order:cancel`; `order-support` and
`admin` carry those plus `order:read` (so an admin token can drive the whole flow,
including the owner-or-staff read paths).

### The `Idempotency-Key` header on Ship

Ship accepts an optional `Idempotency-Key` request header (read with
`@Headers('idempotency-key')`, forwarded onto the RPC payload). It is **accepted and
logged but not deduped** — the same posture as Place Order and Capture. Repeat-safety
comes from state, not the key: a fulfillment is only `pending` once, so a second ship of
the same fulfillment is a `409 FULFILLMENT_INVALID_STATUS_TRANSITION` regardless of the
key. (The retail Ship use case is itself idempotent toward inventory via the
`fulfillmentId` on Commit Sale, but that is a separate, downstream concern.) Key-based
request dedupe is a later capability.

### Error surfacing

A rejected RPC flows back from the retail `OrdersRpcExceptionFilter` as
`{ statusCode, message, code, details? }`. Each gateway use case catches it and re-throws
through the shared `throwRpcError` helper
(`apps/api-gateway/src/common/utils/throw-rpc-error.util.ts`), which **forwards the typed
`code`** (e.g. `ORDER_NOT_FULFILLABLE`, `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING`,
`FULFILLMENT_TRACKING_REQUIRED`, `ORDER_NOT_CANCELLABLE`, `ORDER_PAYMENT_NOT_CAPTURED`)
and any object-valued `details` into the HTTP error body, mapping the status to the right
Nest exception (`400` / `404` / `409` / `403`). A client branches on the stable `code`
rather than the human message.

## 2. The gateway port / adapter extension

The whole front respects the [ADR-009](../../adr/009-port-adapter-at-the-gateway.md)
boundary: **`ClientProxy` from `@nestjs/microservices` appears only in
`infrastructure/messaging/orders-rabbitmq.adapter.ts`**; the controller and use cases
depend on the `ORDERS_GATEWAY_PORT` symbol.

- **`application/ports/orders-gateway.port.ts`** — `IOrdersGatewayPort` gained six
  methods: `createFulfillment` / `shipFulfillment` / `markDelivered` (→
  `FulfillmentView`), `listFulfillments` (→ `FulfillmentView[]`), `cancelOrder` /
  `cancelLine` (→ `OrderView`). Each takes a **business-shaped command/query** (the
  staff-override booleans + `actorId`, `correlationId` omitted — a transport concern the
  adapter stitches on) declared next to the existing `IOrderGetQuery` /
  `IPaymentCaptureCommand`: `IFulfillmentCreateCommand`, `IFulfillmentShipCommand`,
  `IFulfillmentDeliverCommand`, `IFulfillmentListQuery`, `IOrderCancelCommand`,
  `IOrderLineCancelCommand`.
- **`infrastructure/messaging/orders-rabbitmq.adapter.ts`** — `OrdersRabbitmqAdapter`
  (the sole `ClientProxy` holder) gained the six matching `send` methods mapping to
  `ROUTING_KEYS.RETAIL_FULFILLMENT_CREATE` / `_SHIP` / `_DELIVER` / `_LIST` /
  `RETAIL_ORDER_CANCEL` / `_CANCEL_LINE`, stitching `correlationId` onto each wire
  payload (`IRetailFulfillment*Payload` / `IRetailOrderCancel*Payload` from
  `@retail-inventory-system/contracts`). All target `retail_queue` via the
  `RETAIL_MICROSERVICE` client, since the orders controller serves these RPCs (a
  `Fulfillment` is a sibling aggregate of `Order`).
- **`application/use-cases/`** — six thin use cases (`CreateFulfillmentUseCase`,
  `ShipFulfillmentUseCase`, `MarkDeliveredUseCase`, `ListFulfillmentsUseCase`,
  `CancelOrderUseCase`, `CancelLineUseCase`) mirroring `GetOrderUseCase` /
  `CapturePaymentUseCase`: resolve the staff override from `@CurrentUser().permissions`,
  fold `@CurrentUser().id` into `actorId`, call the port, and re-throw through
  `throwRpcError`. They are registered in the gateway `orders.module.ts`.
- **`presentation/dto/`** — `CreateFulfillmentRequestDto` (with the nested
  `FulfillmentLineInputDto` — non-empty `lines`, each `{ orderLineId, quantity }` a
  positive int, recursed via `@ValidateNested({ each: true })` + `@Type`),
  `ShipFulfillmentRequestDto` (`{ trackingNumber?, carrier? }`), `CancelOrderRequestDto`
  (`{ reason? }`), `CancelLineRequestDto` (`{ quantity? }` a positive int). The
  `FulfillmentView` (+ `FulfillmentLineView`) response model is imported from
  `@retail-inventory-system/contracts` for the Swagger response decorators.

The gateway adds **no unit specs** for these thin use cases — the gateway `orders`
module has no use-case spec siblings to mirror, the retail-side use cases already carry
the behavioral coverage, and the real end-to-end coverage is the e2e suite. The build,
`yarn lint`, and `yarn test:unit` stay green.

## 3. The `.http` files

Two [Kulala](https://github.com/mistweaverco/kulala.nvim) request files document the
surface, following the conventions of the sibling files (`@baseUrl = {{ENV_BASE_URL}}`,
`###` separators, `# @name <id>` per request, header comments citing the controller path
+ body shape, and a `# Prereqs:` block with the seeded logins). Variables chain through
the captured response bodies, so each file runs top-to-bottom against a freshly seeded
environment.

### `http/fulfillment.http` — the happy create → ship → deliver flow

1. `loginStaff` → `@accessToken` (admin@example.com — holds `order:fulfill` **and**
   `order:read`, so one operator token drives create/ship/deliver *and* the list/read
   steps); `loginCustomer` → `@customerToken` (customer@example.com — the order owner).
2. `createCart` → `@cartId`; `addLineOne` (variant 1) + `addLineTwo` (variant 3);
   `placeOrder` → `@orderId` plus each line's id + ordered quantity (`@lineOneId`,
   `@lineOneQty`, `@lineTwoId`, `@lineTwoQty`).
3. `createFulfillment` (one shipment covering both lines in full) → `@fulfillmentId`.
4. `listFulfillments` (the staff `order:read` override).
5. `shipFulfillment` (with an `Idempotency-Key`) — observe the inline auto-capture.
6. `markDelivered` — the order rolls up to `delivered`.
7. `getOrder` — observe all three advanced axes: `status=delivered`,
   `paymentStatus=captured`, `fulfillmentStatus=delivered`.

### `http/order-cancel.http` — the cancel cases

1. `loginStaff` → `@accessToken`; `loginCustomer` → `@customerToken`.
2. **Case 1 (owner cancel, pre-fulfillment)**: place order A, then `cancelOrderOwner`
   with the **customer** token (the owner-reachable path) → the authorized payment is
   voided and the allocation released, `status=cancelled`.
3. **Case 2 (cancel a shipped order → `409`)**: place order B (quantity 2), create a
   **partial** fulfillment (quantity 1), ship it, then `cancelOrderShipped` → expect
   `409 ORDER_NOT_CANCELLABLE` (the shipped-fulfillment-presence guard).
4. **Case 3 (cancel a line's remainder)**: `cancelLineB` cancels order B's remaining
   unshipped unit — releasing just that quantity's allocation, no money change.

The variable chaining (`@orderId` → `@fulfillmentId`, and the per-line ids captured from
the place response) is what lets the files run unattended; nothing is hard-coded beyond
the seeded variant ids and the seeded credentials.

## 4. Honored ADRs

- **[ADR-009](../../adr/009-port-adapter-at-the-gateway.md)** — the port→adapter split:
  `ClientProxy` is confined to `OrdersRabbitmqAdapter`; the controller + use cases depend
  on `ORDERS_GATEWAY_PORT`.
- **[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) /
  [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) §7** — the owner-check
  is authentication + a retail-side ownership assertion, never a customer permission
  code; a permission code is a staff override. The owner-or-staff routes carry no
  `@RequiresPermission`; the staff-only routes carry it directly.
- **[ADR-031](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)** — the
  fulfillment aggregate + ship-triggered capture this surface fronts.
