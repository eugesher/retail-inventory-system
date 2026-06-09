---
epic: epic-05
task_number: 7
title: Capture Payment + Get Order + List My Orders + gateway modules/orders (owner-check) + order:capture permission + seed
depends_on: [1, 2, 3, 4, 5, 6]
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/07-authorize-on-place-capture-explicit-q5.md
---

# Task 07 — Capture Payment + Get Order + List My Orders + gateway `modules/orders/`

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-028** (capture is an explicit operation (Q5); customer
authorization = bearer + owner-check; `order:read` / `order:capture` are the **staff
overrides**, not customer gates), **ADR-024** (`PermissionCodeEnum` is the single
source of truth — add the new code there; customers carry no permissions, so a
permission gate is a *staff* override layered over an owner-check; `@CurrentUser()`
gives `permissions: string[]`), **ADR-009** (gateway port-and-adapter; the gateway
`orders` module has no `domain/`; `ClientProxy` only in `infrastructure/messaging`),
**ADR-026** (`PriceView.amountMinor` minor units — capture amount defaults to the
order's `grandTotalMinor`), **ADR-020** (post-commit publish best-effort).

## Goal

Ship the explicit **Capture Payment** operation and the two order read paths (**Get
Order**, **List My Orders**), front them in a new gateway `modules/orders/` with
**bearer + owner-check** (and `order:read` / `order:capture` as staff overrides), add
the `order:capture` permission code + seed it, rewrite `http/order.http`, and extend
the walking-skeleton e2e (steps 6–8) + add the list e2e.

## Entry state assumed

- task-01–06 complete. Place Order works end-to-end (a placed order is `pending` /
  `paymentStatus=authorized` / `fulfillment=unfulfilled` with an authorized
  `Payment`); `Order.markPaymentCaptured()`, `Payment.capture(at)`,
  `IOrderRepositoryPort.{findById,findBySourceCartId,listByCustomer}`,
  `IPaymentRepositoryPort.{findByOrderId,save}`, the orders `TRANSACTION_PORT`, the
  `PAYMENT_GATEWAY` (`capture`), and `OrderRabbitmqPublisher` exist; the gateway
  `modules/cart/` owns the place route. `PermissionCodeEnum` has `ORDER_READ` but
  **not** `ORDER_CAPTURE`. The seed binds `order-support` → `order:read|cancel|refund`
  and `admin` → every code (`Object.values`).
- `http/order.http` currently holds only the place request (from task-06).

## Permission code + seed

- Add `ORDER_CAPTURE = 'order:capture'` to `PermissionCodeEnum`
  (`libs/contracts/auth/permission.enum.ts`) — it matches `^[a-z][a-z-]*:[a-z][a-z-]*$`.
- In `scripts/test-db-seed.ts`: add it to `PERMISSION_SEEDS` (next free stable UUID,
  e.g. `…-b000-00000000000e`) and to the **`order-support`** role's permission list.
  `admin` picks it up automatically (`permissions: Object.values(PermissionCodeEnum)`).
  Keep the seed idempotent (`INSERT IGNORE`).
- **Do not** add `customer:own-orders:read` — customer order reads are owner-checked,
  not permission-gated (ADR-024 / ADR-028).

## Use cases (retail — `apps/.../orders/application/use-cases/`)

- `CapturePaymentUseCase` — input `{ orderId, amountMinor?, actorId, isStaffCapture,
  correlationId }`. Loads the order + its `Payment` (`findByOrderId`); **authorizes
  the caller**: allow if `isStaffCapture` (the gateway already checked `order:capture`)
  **or** `order.customerId === actorId` (owner) — else reject `403`. Reject `409` if
  the payment is not `authorized` (already captured/failed). Inside a transaction:
  `PAYMENT_GATEWAY.capture(payment.gatewayReference)` → `payment.capture(capturedAt)`
  + save; `order.markPaymentCaptured()` + save. Post-commit: emit
  `retail.payment.captured` `{ orderId, paymentId, amountMinor, currency,
  eventVersion:'v1', occurredAt, correlationId }` → `retail_queue` (reserved). The
  `Idempotency-Key` is accepted + logged, not deduped (Q10) — a re-capture of an
  already-`captured` payment returns the current `captured` state (idempotent by
  payment state) rather than erroring. Returns the updated `PaymentView` (or the
  `OrderView`). `amountMinor` defaults to the order's `grandTotalMinor` (partial
  capture is a later capability).
- `GetOrderUseCase` — input `{ orderId, actorId, canReadAny, correlationId }`. Loads
  the order + lines + payment. Authorizes: allow if `canReadAny` (staff `order:read`)
  **or** `order.customerId === actorId`; else `403`. `404` if missing. Returns the
  `OrderView`.
- `ListMyOrdersUseCase` — input `{ customerId, page, correlationId }`. Returns a
  paginated `IPage<OrderView>` of the caller's own orders (`listByCustomer`,
  newest-first by `placed_at`). Lists **own only** (admin all-orders listing is a
  later refinement).

## Routing keys + contracts

Add to `ROUTING_KEYS` (+ `MicroserviceMessagePatternEnum` + the routing-keys spec):
- `RETAIL_ORDER_GET: 'retail.order.get'` (RPC)
- `RETAIL_ORDER_LIST: 'retail.order.list'` (RPC)
- `RETAIL_PAYMENT_CAPTURE: 'retail.payment.capture'` (RPC)
- `RETAIL_PAYMENT_CAPTURED: 'retail.payment.captured'` (event, reserved)

New wire contract `IRetailPaymentCapturedEvent extends ICorrelationPayload`
`{ orderId, paymentId, amountMinor, currency, eventVersion:'v1', occurredAt }`. The
RPC payloads carry the resolved `actorId` + the staff-override flags
(`canReadAny` / `isStaffCapture`) the gateway computes from `@CurrentUser().permissions`.

The retail `orders.controller.ts` registers `@MessagePattern`s for `retail.order.get`,
`retail.order.list`, `retail.payment.capture` (alongside the `retail.cart.place`
handler from task-06).

## Gateway `modules/orders/` (new)

Per-module hexagonal, **no `domain/`**. `application/ports` (`ORDERS_GATEWAY_PORT`),
`application/use-cases` (thin; compute the staff-override flag from
`@CurrentUser().permissions.includes('order:read'|'order:capture')` and pass
`actorId = @CurrentUser().id`), `infrastructure/messaging/orders-rabbitmq.adapter.ts`
(the only `ClientProxy` site), `presentation/orders.controller.ts` + `dto/*`. Routes
(`@ApiTags('Order')`):

| Method | Path | Body / params | Auth | Use case |
|---|---|---|---|---|
| `GET` | `/api/orders/:orderId` | — | bearer; owner **or** `order:read` | GetOrder |
| `GET` | `/api/orders` | pagination query (`page`, `pageSize`) | bearer (own only) | ListMyOrders |
| `POST` | `/api/orders/:orderId/payments/capture` | optional `{ amountMinor }`, header `Idempotency-Key` | bearer; owner **or** `order:capture` | CapturePayment |

- These routes carry **no `@RequiresPermission`** (that would block the owning
  customer). The staff override is computed inside the gateway use case from
  `@CurrentUser().permissions` and forwarded to the retail use case as
  `canReadAny` / `isStaffCapture`. The owner-check lives in the retail use case.
- DTOs: `ListOrdersQueryDto` (`page`/`pageSize` with sane defaults at the edge);
  `CapturePaymentRequestDto` (`amountMinor?` positive int). Read the
  `Idempotency-Key` header via `@Headers`.
- Register `OrdersModule` in the gateway `AppModule`.

## `http/order.http` (rewritten)

Rewrite fully. `@baseUrl = {{ENV_BASE_URL}}`; `###` separators; `# @name` per
request; header comments citing controller paths. A `# Prereqs:` block: log in the
seeded customer, capture `@accessToken`; create a cart + add the two seeded variants
(reference the cart flow); capture `@cartId`. Requests: `placeOrder`
(`POST /api/cart/{{cartId}}/place` with addresses + `Idempotency-Key: {{$guid}}`,
capturing `@orderId`), `getOrder` (`GET /api/orders/{{orderId}}`), `listMyOrders`
(`GET /api/orders?page=1&pageSize=10`), `capturePayment`
(`POST /api/orders/{{orderId}}/payments/capture` with `Idempotency-Key: {{$guid}}`),
and a `placeOrderAgain` documenting the same-order idempotent repeat. No
`tmp/`/"epic"/"task" strings.

## Files to add

- `apps/.../orders/application/use-cases/capture-payment.use-case.ts`,
  `get-order.use-case.ts`, `list-my-orders.use-case.ts` (+ update `index.ts` +
  `spec/*`).
- Gateway `apps/api-gateway/src/modules/orders/` full tree (`application/ports/*`,
  `application/use-cases/*`, `infrastructure/messaging/orders-rabbitmq.adapter.ts`,
  `presentation/orders.controller.ts`, `presentation/dto/*`, `orders.module.ts`,
  `index.ts`).
- `libs/contracts/retail/events/payment-captured.event.ts`.
- `test/order-list-my-orders.e2e-spec.ts`.

## Files to modify

- `apps/.../orders/infrastructure/orders.module.ts` — register the three use cases;
  extend `OrderRabbitmqPublisher` (+ `IOrderEventsPublisherPort`) with
  `publishPaymentCaptured`; add the three `@MessagePattern`s to the controller.
- `libs/contracts/auth/permission.enum.ts` — add `ORDER_CAPTURE`.
- `scripts/test-db-seed.ts` — seed `order:capture` (+ bind to `order-support`).
- `libs/messaging/routing-keys.constants.ts` + `spec/routing-keys.constants.spec.ts`;
  `libs/contracts/microservices/microservice-message-pattern.enum.ts`.
- `libs/contracts/retail/{index,events/index}.ts`.
- `apps/api-gateway/src/app/app.module.ts` — import `OrdersModule`.
- `http/order.http` — full rewrite.
- `test/cart-to-order-walking-skeleton.e2e-spec.ts` — extend with steps 6–8.
- `docs/implementation/05-cart-order-payment-walking-skeleton/07-authorize-on-place-capture-explicit-q5.md`
  — complete the explicit-capture section.

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`):
  - `capture-payment.use-case.spec.ts` — owner capture succeeds (`authorized →
    captured`, `Order.paymentStatus=captured`, `retail.payment.captured` emitted);
    staff capture (`isStaffCapture`) succeeds for a non-owner; a non-owner non-staff
    is rejected `403`; capturing a non-`authorized` payment is handled (idempotent
    return on already-`captured`, `409` on `failed`); `amountMinor` defaults to the
    grand total.
  - `get-order.use-case.spec.ts` — owner reads own; staff (`canReadAny`) reads any;
    a non-owner non-staff is `403`; `404` on missing.
  - `list-my-orders.use-case.spec.ts` — returns only the caller's orders, paginated,
    newest-first.
- **E2E** (`yarn test:e2e`):
  - `test/cart-to-order-walking-skeleton.e2e-spec.ts` (steps **6–8**, extending the
    place flow from the prior task): step 6 — `GET /api/orders/:orderId` shows the
    populated snapshots (`sku`, `nameSnapshot`, `unitPriceMinor`); step 7 — the
    customer `POST …/payments/capture` → `paymentStatus=captured` + the `Payment`
    row `captured` + `retail.payment.captured` published; step 8 — repeat the place
    with the same `Idempotency-Key` → the **same** `orderId` + `paymentId` (cart-state
    idempotency; cite that key-based dedupe is a later capability).
  - `test/order-list-my-orders.e2e-spec.ts` — place two orders for the seeded
    customer; `GET /api/orders` returns both (paginated, newest-first); a **second**
    customer's `GET /api/orders` does not see them; `GET /api/orders/:otherOrderId`
    by a non-owner → `403`; a staff token with `order:read` can `GET` any order.
- Keep the seed idempotent; the e2e boots gateway + retail + catalog.

## Doc deliverable

`07-authorize-on-place-capture-explicit-q5.md` — **complete** the doc (the authorize
half was written in the place task). Add the **explicit capture** section: why
capture is a separate operation (Q5 — authorize-on-place, capture-on-ship is the
default policy; making capture explicit keeps other policies achievable);
ship-triggered automatic capture is a later fulfillment capability; the
owner-or-`order:capture` authorization (and why a permission code is a *staff*
override over the owner-check, not a customer gate — ADR-024); idempotent
re-capture by payment state. Cross-link `docs/adr/028-…md`, `docs/adr/024-…md`, and
`08-idempotency-key-header-q10.md`. Describe everything by capability — never by an
epic/task number.

## Carryover to read

`carryover-01.md` … `carryover-06.md`.

## Carryover to produce

Write `carryover-07.md`. Capture: the Capture / Get / List use-case contracts + the
owner-vs-staff-override authorization; the `order:capture` permission code + its seed
binding; the new keys (`retail.order.get` / `.list` / `retail.payment.capture` RPCs,
`retail.payment.captured` event); the gateway `modules/orders/` routes; the rewritten
`http/order.http`; the completed walking-skeleton e2e (1–8) + the list e2e. Note that
the only remaining work is task-08 (notification consumer re-point to
`retail.order.placed` + its e2e) and task-09 (example-cart seed, docs `09`/`10`,
README/CLAUDE full pass, architecture-lint fixtures, final grep). List verify
commands incl. the full `http/order.http` sequence.

## Exit criteria

- [ ] `POST /api/orders/:orderId/payments/capture` captures (owner or `order:capture`),
      advancing the `Payment` to `captured` and `Order.paymentStatus` to `captured`,
      emitting `retail.payment.captured`.
- [ ] `GET /api/orders/:orderId` (owner or `order:read`) and `GET /api/orders`
      (own only) work; a non-owner non-staff gets `403`; unauthenticated `401`.
- [ ] `order:capture` is in `PermissionCodeEnum`, seeded, and bound to `order-support`
      (+ `admin`); no `customer:own-orders:read` code was added.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` + `yarn test:e2e` pass
      (`cart-to-order-walking-skeleton` steps 1–8 + `order-list-my-orders` green).
- [ ] Every `http/order.http` request executes end-to-end.
- [ ] `07-authorize-on-place-capture-explicit-q5.md` is completed.
- [ ] The self-containment grep is clean.
- [ ] `carryover-07.md` is written.
