# Carryover 07 — Capture Payment + Get Order + List My Orders + gateway `modules/orders/`

## Entry state for task-08

The order **read + capture** surface is **live end to end**. The retail orders
controller now binds **four** `@MessagePattern`s on `retail_queue` (the place RPC +
the three new ones), and a new gateway `modules/orders/` fronts the read+capture RPCs
over HTTP at `/api/orders`. The full walking skeleton (login → cart → place → get →
capture → repeat) is green, plus a dedicated list e2e.

### Capture / Get / List use cases (`apps/retail-microservice/.../orders/application/use-cases/`)

- **`CapturePaymentUseCase`** — input `IRetailPaymentCapturePayload { orderId,
  actorId, isStaffCapture, amountMinor?, idempotencyKey?, correlationId }`. Loads the
  order (`findById`; missing → `ORDER_NOT_FOUND` 404) → **owner-or-staff** authorize
  (`isStaffCapture || order.customerId === actorId`, else `ORDER_ACCESS_FORBIDDEN`
  403) → loads the payment (`findByOrderId`; null → `ORDER_INVALID_PAYMENT_TRANSITION`
  409). **Idempotent by payment state**: a `captured` payment returns the current
  `OrderView` (no gateway call, no write, no event); any other non-`authorized` state
  (failed/voided/refunded) → `PAYMENT_INVALID_STATUS_TRANSITION` 409. On an
  `authorized` payment: `PAYMENT_GATEWAY.capture(gatewayReference)` **outside** the tx
  (declined → `ORDER_PAYMENT_NOT_CAPTURED` 409, unreachable with the fake), then a
  short follow-up tx `payment.capture(at)` + `paymentRepo.save(scope)` +
  `order.markPaymentCaptured()` + `orderRepo.save(scope)`. Re-reads both, emits
  `retail.payment.captured` best-effort post-commit, returns the updated `OrderView`.
  `amountMinor` defaults to `order.grandTotalMinor` (partial capture is a later
  capability — the fake captures the full authorized amount).
- **`GetOrderUseCase`** — input `IRetailOrderGetPayload { orderId, actorId,
  canReadAny, correlationId }`. `findById` (404 missing) → **owner-or-staff**
  (`canReadAny || order.customerId === actorId`, else `ORDER_ACCESS_FORBIDDEN` 403) →
  `findByOrderId` for the payment → `toOrderView(order, payment)`.
- **`ListMyOrdersUseCase`** — input `IRetailOrderListPayload { customerId, page,
  pageSize, correlationId }`. **Own-only** (no staff override): `listByCustomer`
  (newest-first `placed_at DESC`), maps to `IPage<OrderView>`. The list projection
  **omits the per-order `payment`** (avoids an N+1; a single-order GET includes it).
  Clamps `pageSize` to `[1, 100]` (default 20), `page` floor 1.

**Returns `OrderView` for capture** (not `PaymentView`) so the response shows both the
order's `paymentStatus=captured` and the folded `payment.status=captured` — the e2e
asserts both. `CapturePaymentUseCase` reuses the existing `AuthorizePaymentUseCase`
transaction/gateway pattern symmetrically.

### Publisher extension

`IOrderEventsPublisherPort` + `OrderRabbitmqPublisher` gained
**`publishPaymentCaptured(event)`** → `retail.payment.captured` onto `retail_queue`
(the producer's own queue, reserved surface) via the `RETAIL_MICROSERVICE` client.

### New `OrderErrorCodeEnum` codes (`domain/order.exception.ts`)

- `ORDER_ACCESS_FORBIDDEN` (403) — owner-or-staff failure on the **order** read/capture
  paths (distinct from `ORDER_CART_ACCESS_FORBIDDEN`, which is place-time).
- `ORDER_PAYMENT_NOT_CAPTURED` (409) — gateway declined capture (modeled, unreachable
  with the fake; symmetric to `ORDER_PAYMENT_NOT_APPROVED`).
Both added to the **total** `OrdersRpcExceptionFilter` `Record`.

### Gateway `modules/orders/` (`apps/api-gateway/src/modules/orders/`)

Per-module hexagonal, **no `domain/`** (ADR-009). `ORDERS_GATEWAY_PORT` →
`IOrdersGatewayPort` (getOrder / listMyOrders / capturePayment); `OrdersRabbitmqAdapter`
is the **sole `ClientProxy` holder** (via the `RETAIL_MICROSERVICE` client); three thin
use cases compute the staff override + fold `@CurrentUser().id` into `actorId`;
`presentation/orders.controller.ts` + `dto/{list-orders.query,capture-payment.request}.dto.ts`.
Registered in gateway `app.module.ts`. Routes (`@ApiTags('Order')`, `@ApiBearerAuth()`):

| Method | Path | Body / query | Auth | Use case |
|---|---|---|---|---|
| GET | `/api/orders` | `?page`/`?pageSize` (default 1/20) | bearer (own only) | ListMyOrders |
| GET | `/api/orders/:orderId` | — | bearer; owner **or** `order:read` | GetOrder |
| POST | `/api/orders/:orderId/payments/capture` | `{ amountMinor? }` + `Idempotency-Key` header | bearer; owner **or** `order:capture` | CapturePayment |

**No `@RequiresPermission` on any route** (it would block the owning customer — ADR-024):
the gateway use case computes `canReadAny = permissions.includes(ORDER_READ)` /
`isStaffCapture = permissions.includes(ORDER_CAPTURE)` and forwards the boolean; the
**retail use case is the single owner-check enforcement point**. Capture is `@HttpCode(200)`
(not a creation). `orderId` is `ParseIntPipe` (BIGINT `order.id`).

### Permission code + seed

- `PermissionCodeEnum.ORDER_CAPTURE = 'order:capture'` added (between `ORDER_READ`
  and `ORDER_CANCEL`).
- `scripts/test-db-seed.ts`: seeded with stable UUID `…-b000-00000000000e`, bound to
  the **`order-support`** role (and `admin` via `Object.values`). `INSERT IGNORE`,
  idempotent. **No `customer:own-orders:read` code** — customer order reads are
  owner-checked, not permission-gated.

### New routing keys + contracts

`ROUTING_KEYS` + `MicroserviceMessagePatternEnum` (+ the routing-keys spec) gained:
- `RETAIL_ORDER_GET = 'retail.order.get'` (RPC)
- `RETAIL_ORDER_LIST = 'retail.order.list'` (RPC)
- `RETAIL_PAYMENT_CAPTURE = 'retail.payment.capture'` (RPC)
- `RETAIL_PAYMENT_CAPTURED = 'retail.payment.captured'` (event, reserved)

New contracts in `libs/contracts/retail`:
- `events/payment-captured.event.ts` → `IRetailPaymentCapturedEvent { orderId,
  paymentId, amountMinor, currency, eventVersion:'v1', occurredAt }`.
- `interfaces/order-query.interface.ts` → `IRetailOrderGetPayload` /
  `IRetailOrderListPayload` / `IRetailPaymentCapturePayload` (each carries the resolved
  `actorId` + the staff-override flag the gateway computes). `IPage<OrderView>` is
  **reused** from the catalog contracts barrel (re-exported at the contracts root) for
  the list — no new page type.

## Key decisions & deviations (task-08/09 must respect)

- **Owner-check is the retail use case's job; the staff override is a gateway-computed
  boolean.** The wire payloads carry `canReadAny`/`isStaffCapture`, NOT the raw
  permission list — the retail service trusts the resolved flag and never re-reads the
  permission registry. A customer's override is always `false` (no permissions claim).
- **Capture returns `OrderView`** (the whole order with the captured payment folded
  in), not a bare `PaymentView` — uniform with Get, and lets the response show both
  status axes.
- **Idempotent re-capture by payment state** (Q10), mirroring repeat-place's cart-state
  idempotency. `Idempotency-Key` accepted + logged, never deduped.
- **List omits `payment`** to avoid an N+1; the single-order GET includes it.
- **The e2e fakes were extended, not rewritten:** `FakePaymentGateway` gained
  `captureCount` + a `captureOk` ctor flag; `SpyOrderEventsPublisher` gained
  `captured` + `publishPaymentCaptured`; `FakeOrderRepository.listByCustomer` now sorts
  newest-first (mirroring the real repo) and applies the page window; new
  `buildOrderFixture` / `buildPaymentFixture` use the `reconstitute` load path so the
  read/capture specs seed any status directly.
- **No new migration** (no schema change — the four order tables + `payment` already
  exist from task-03/04).

## Known gaps / deferrals (each names its owning task)

- **Notification re-point** — the active `retail.order.placed` consumer
  (order-confirmation fan-out) + a re-added notification e2e → **task-08**. The
  `retail.payment.authorized` / `.captured` events stay reserved surfaces.
- **Example-cart seed, docs `09`/`10`, README/CLAUDE full final pass,
  architecture-lint fixtures, final grep** → **task-09**.
- **Partial capture, void/refund/fail, ship-triggered auto-capture, admin all-orders
  listing** — later fulfillment/payment capabilities (not this epic).
- **True `Idempotency-Key` dedupe** (a persisted idempotency store) → a later
  idempotency-persistence capability (doc 08).

## How to verify (all green as of this task)

- `yarn build` — all five apps compile.
- `yarn lint` — clean (`--max-warnings 0`).
- `yarn test:unit` — **649 pass** (was 636; +13 from the capture/get/list specs).
- `yarn test:e2e` (infra reload + migrate + seed) — **113 pass** (14 suites; was
  99/12). `cart-to-order-walking-skeleton` runs steps 1–8 (place → assert axes/line
  snapshots/payment → both place events → **step 6** `GET /api/orders/:id` snapshots →
  **step 7** owner capture → `paymentStatus=captured` + `retail.payment.captured`
  published → **step 8** repeat-place returns the same order + paymentId).
  `order-list-my-orders` places two orders for a fresh customer, asserts own-only
  newest-first listing, a second customer sees none + gets `403` on the first's order,
  a staff `order:read` token reads any, and an anonymous list is `401`.
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- **`http/order.http` full sequence** (after `docker compose up -d && yarn migration:run
  && yarn test:seed && yarn start:dev`): `login` → `createCart` (→ `@cartId`) →
  `addLineOne` → `addLineTwo` → `placeOrder` (Idempotency-Key header, → `@orderId`) →
  `getOrder` → `listMyOrders` → `capturePayment` (→ `paymentStatus=captured`) →
  `placeOrderAgain` (same order, cart-state idempotency).
