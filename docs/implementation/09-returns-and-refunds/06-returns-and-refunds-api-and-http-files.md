# Returns & Refunds — the gateway HTTP surface and the `.http` files

Everything before this document made the returns + refunds capability reachable only
microservice-to-microservice over RabbitMQ. This document covers the last leg: the **API
Gateway HTTP surface** that fronts those RPCs for an outside caller, and the Kulala
`.http` files that exercise it end-to-end.

There are ten new routes. They split across two concerns — the **return (RMA) lifecycle**
and the **order-scoped refund** — and that split drives where they live in the gateway:

- a **new gateway `modules/returns/`** for the eight return-lifecycle routes, and
- an **extension of the gateway `modules/orders/`** for the two refund routes.

The retail-side RPCs they call are described in
[`01-rma-lifecycle.md`](./01-rma-lifecycle.md) (the RMA state machine),
[`02-return-line-disposition-and-restock.md`](./02-return-line-disposition-and-restock.md)
(inspect + restock), [`03-refund-as-distinct-entity.md`](./03-refund-as-distinct-entity.md)
+ [`05-fake-gateway-refund-method.md`](./05-fake-gateway-refund-method.md) (Issue / List
Refund), and [`04-auto-refund-from-cancel-order.md`](./04-auto-refund-from-cancel-order.md)
(the cancel-driven auto refund). The cross-cutting rules are
[`docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md`](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md),
[`docs/adr/009-port-adapter-at-the-gateway.md`](../../adr/009-port-adapter-at-the-gateway.md),
and [`docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md`](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
/ [`docs/adr/028-cart-order-payment-and-address-chain.md`](../../adr/028-cart-order-payment-and-address-chain.md)
§7 (the authorization shapes).

## 1. The HTTP surface

| Method | Path | Body | Auth | RPC |
|---|---|---|---|---|
| `POST` | `/api/orders/:orderId/returns` | `{ reasonCategory, notes?, lines: [{ orderLineId, quantity }] }` | owner **or** `order:return-authorize` | `retail.return.open` |
| `POST` | `/api/returns/:rmaId/authorize` | — | `order:return-authorize` | `retail.return.authorize` |
| `POST` | `/api/returns/:rmaId/reject` | `{ reason }` | `order:return-authorize` | `retail.return.reject` |
| `POST` | `/api/returns/:rmaId/receive` | — | `inventory:receive-return` | `retail.return.receive` |
| `POST` | `/api/returns/:rmaId/inspect` | `{ lines: [{ returnLineId, condition, disposition, lineRefundAmountMinor }] }` | `inventory:receive-return` | `retail.return.inspect` |
| `POST` | `/api/returns/:rmaId/close` | — | `order:return-authorize` | `retail.return.close` |
| `GET` | `/api/returns/:rmaId` | — | owner **or** `order:read` | `retail.return.get` |
| `GET` | `/api/orders/:orderId/returns` | — | owner **or** `order:read` | `retail.return.list` |
| `POST` | `/api/orders/:orderId/refunds` | `{ paymentId, amountMinor, reason }`, header `Idempotency-Key` | `order:refund` | `retail.refund.issue` |
| `GET` | `/api/orders/:orderId/refunds` | — | owner **or** `order:read` | `retail.refund.list` |

### The two authorization shapes

The whole returns + refunds surface is governed by the gateway's two-shape authorization
model (ADR-024, ADR-028 §7). The pivotal fact is that **a customer token carries no
`permissions` claim**:
RBAC permission codes are inflated onto staff tokens only. That single fact forces the
split.

**Owner-or-staff routes** — Open, Get return, List returns, List refunds. A customer must
be able to open and read *its own* returns and refunds. If these routes carried
`@RequiresPermission(...)`, the `PermissionsGuard` would reject the owning customer (no
permission claim → 403) before the request ever reached a use case. So these routes carry
**no `@RequiresPermission`** at all. Instead:

- the controller folds the verified `@CurrentUser().id` into the wire payload's
  `customerId` (Open) / `actorId` (the reads);
- the gateway use case computes a **staff override** boolean from
  `@CurrentUser().permissions` — `isStaff = permissions.includes('order:return-authorize')`
  for Open, `permissions.includes('order:read')` for the reads — and forwards it;
- the **retail use case is the single enforcement point**: it allows the operation if the
  override is set **or** the caller owns the order/RMA, else answers 403
  (`RETURN_ACCESS_FORBIDDEN` / `REFUND_ACCESS_FORBIDDEN`).

A customer's override is always `false` (no permissions), so it can only ever reach its
own resources; a staff member with the override reaches any. This is the key idea: **a
permission code is a staff override layered on top of the owner-check, never a gate on the
owning customer.**

**Staff-only routes** — Authorize, Reject, Close (`order:return-authorize`); Receive,
Inspect (`inventory:receive-return`); Issue Refund (`order:refund`). These are *not* owner
operations: a customer cannot authorize its own return, log returned goods into the
warehouse, record an inspection, or refund itself. So they ARE gated directly with
`@RequiresPermission(<code>)` — the simpler, correct shape. The `PermissionsGuard` rejects
a customer (and any staff member lacking the code) up front. The use case still folds
`@CurrentUser().id` into `actorId` (always a staff id past the gate) so the audit / restock
attribution and the retail-side enforcement point stay consistent across both shapes.

This mirrors exactly how the fulfillment + cancel surface already works (Create/Ship/Deliver
are `order:fulfill`-gated; Cancel Order and the reads are owner-or-staff) — see the orders
controller's class comment.

## 2. Module placement — why a new `modules/returns/` but a refund *extension*

The return lifecycle is a self-contained six-state machine with its own eight RPCs, its own
view (`ReturnRequestView`), and its own bounded context on the retail side (`modules/returns/`,
a separate module rather than a sibling in `orders/`). The gateway mirrors that: a **new
`modules/returns/`** with its own port (`RETURNS_GATEWAY_PORT`), adapter
(`ReturnsRabbitmqAdapter`, the sole `ClientProxy` holder), eight thin use cases, three DTOs,
and a controller. It is the same port→adapter shape as every other gateway fronting module
(ADR-009): the controller and use cases depend only on the `IReturnsGatewayPort` interface,
and the adapter is the only file that imports `@nestjs/microservices`.

The returns controller is declared with an **empty `@Controller()`** (no path prefix), so
it can serve both the order-scoped routes (`orders/:orderId/returns`) and the RMA-scoped
routes (`returns/:rmaId/*`) from one class. Nest resolves routes by full path, so this
coexists with the orders controller's `orders/:orderId/...` routes without a clash.

The **refund** routes, by contrast, are order-scoped — `/api/orders/:orderId/refunds`. A
refund is a sibling of `Payment` inside the retail `orders/` module (a refund's operations
mutate a `Payment`); on the gateway the natural home is therefore the existing
`modules/orders/`, next to capture and cancel. Rather than spend a whole new gateway module
on two routes, the refund surface **extends** `modules/orders/`:

- `IOrdersGatewayPort` + `OrdersRabbitmqAdapter` gain `issueRefund` / `listRefunds`;
- two thin use cases (`IssueRefundUseCase`, `ListRefundsUseCase`) are added;
- a **second controller** — `RefundsController`, declared `@Controller('orders')` — hosts
  the two routes. It shares the `orders` prefix with `OrdersController` but the route paths
  differ, so both register cleanly (the catalog module's category/media multi-controller
  precedent). Keeping refunds on their own controller keeps the already-large orders
  controller focused.

## 3. `throwRpcError` passthrough — typed codes survive the boundary

Every gateway use case wraps its adapter call in `try/catch` and re-throws through the
shared `common/utils/throwRpcError`. The retail-side RPC exception filters already emit
`{ statusCode, message, code }` (the returns filter is a *total* `Record<ReturnErrorCodeEnum,
HttpStatus>`; the orders filter covers the `REFUND_*` arms), and `throwRpcError` maps that
`statusCode` to the matching Nest `HttpException` while **forwarding the typed `code`** (and
an object-valued `details`, when present) into the response body. So a client sees, for
example:

- `404 { code: 'RETURN_NOT_FOUND' }` for an unknown RMA,
- `409 { code: 'RETURN_WINDOW_EXPIRED' }` when a shipped order is past its window,
- `409 { code: 'RETURN_QUANTITY_EXCEEDS_RETURNABLE' }` for an over-return,
- `400 { code: 'RETURN_INSPECTION_INVALID' }` for an incomplete inspection set,
- `409 { code: 'REFUND_EXCEEDS_REFUNDABLE' }` for an over-refund,
- `409 { code: 'REFUND_PAYMENT_NOT_CAPTURED' }` when the payment is not captured,
- `403 { code: 'REFUND_ACCESS_FORBIDDEN' }` / `403 { code: 'RETURN_ACCESS_FORBIDDEN' }` for
  a non-owner non-staff caller.

A client branches on the stable `code` rather than brittle-matching a human message — the
gateway never re-derives or re-maps these codes, it just forwards them. The gateway's own
DTO validation (the `class-validator` decorators) is the only thing that produces a 400
*before* an RPC is dispatched (a malformed body, e.g. an empty `lines` array or a negative
`amountMinor`).

## 4. The `.http` files

Two new Kulala files document the surface end-to-end against the seeded environment
(`http/http-client.env.json` already defines `ENV_BASE_URL`; no new env value is needed).
Both follow the existing conventions — `@baseUrl = {{ENV_BASE_URL}}`, `###` separators, a
`# @name` per request, a header comment citing the controller path + body shape, and a
`# Prereqs:` block that logs in the seeded users and captures the bearer tokens.

The seeded **admin** (`admin@example.com`) holds *every* permission, so one operator token
drives every staff step in both files. The comments record the production role split that
admin's superset papers over: **order-support** (`support@example.com`) holds
`order:return-authorize` + `order:refund` (authorize/reject/close + issue refund);
**warehouse-staff** (`warehouse@example.com`) holds `inventory:receive-return`
(receive/inspect). Neither role holds the other's codes, which is exactly why the
owner-or-staff vs staff-only split exists.

### `http/returns.http` — the full RMA lifecycle + restock

The file builds a **delivered** order (place → fulfill → ship → deliver) so the return
window is satisfied (a delivered order is always returnable — see
[`01-rma-lifecycle.md`](./01-rma-lifecycle.md) §7), then walks the RMA:

`openReturn` (the **customer** opens its own return — the owner path, no permission code;
captures `@rmaId` + `@returnLineId`) → `authorizeReturn` → `receiveReturn` → `inspectReturn`
(a `restock` disposition — the cross-service `inventory.stock.restock-from-return` RPC fires
after the inspect commit, adding the unit back to `quantity_on_hand` and writing a positive
`return` `StockMovement`; see
[`02-return-line-disposition-and-restock.md`](./02-return-line-disposition-and-restock.md))
→ `closeReturn` → `getReturn` + `listOrderReturns` to read the final state back. A
shape-only `rejectReturn` request documents the reject body without breaking the happy
chain (the RMA is already closed by then).

### `http/refunds.http` — the manual refund + the auto-refund trace

Two cases:

- **Case 1 — manual goodwill refund (no return).** place → `capturePayment` (captures the
  authorized payment so it is refundable; captures `@paymentId` from the embedded
  `payment.id`) → `issueRefund` (a *partial* refund of 1000 of the 4999 captured — staff
  `order:refund`, with an `Idempotency-Key` header) → `listRefunds`. This is the refund that
  needs no return at all — a price adjustment / goodwill credit, the reason
  [`03-refund-as-distinct-entity.md`](./03-refund-as-distinct-entity.md) keeps `Refund`
  distinct from `ReturnRequest`.
- **Case 2 — auto-refund-from-cancel.** place → `capturePaymentB` (capture **without**
  shipping) → `cancelOrderB`. Cancelling a captured-but-unshipped order flags the payment
  for refund and emits `retail.order.cancelled`; the retail `OrderCancelledConsumer`
  consumes its own event and issues the full refund **inline — there is no HTTP call for the
  refund itself** (see [`04-auto-refund-from-cancel-order.md`](./04-auto-refund-from-cancel-order.md)).
  `listRefundsB` then shows the auto-issued refund. This trace is the reason the refund use
  case audits retail-side rather than at the gateway: the cancel-driven path never crosses
  the gateway, so a gateway-only audit would miss it.

## 5. What this does and does not add

This change adds **only** the gateway HTTP front and the `.http` files. It introduces no new
domain logic, no migration, no new permission code (the three codes
`order:return-authorize`, `inventory:receive-return`, `order:refund` were seeded earlier and
gain their first HTTP endpoints here), and no new wire contract — every payload, view, and
routing key already existed for the RPC layer. The behavioral coverage for these routes is
the gateway e2e suite that drives the same HTTP surface (login → place → … → return →
refund) and asserts through public state.
