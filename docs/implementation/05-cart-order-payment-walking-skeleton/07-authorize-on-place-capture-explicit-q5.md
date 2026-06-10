# 07 — Authorize on place, capture explicit

Payment in this checkout chain splits into two distinct moments: **authorization**
happens automatically when an order is placed, and **capture** is a separate,
explicit operation performed later. This is the common storefront default —
authorization reserves the funds the moment the buyer commits, while capture (taking
the money) is deferred to an operator/fulfillment action
([ADR-028 §3](../../adr/028-cart-order-payment-and-address-chain.md)). This document
covers both halves: **authorize-on-place** first, then **explicit capture** with its
owner-or-staff authorization and idempotent re-capture.

## The payment gateway seam

All payment integration sits behind the **`PAYMENT_GATEWAY` port**
(`IPaymentGatewayPort`), whose default binding is the in-process
`FakePaymentGatewayAdapter` that always approves and mints deterministic
`fake_<uuid>` references with no external calls
([ADR-028 §4](../../adr/028-cart-order-payment-and-address-chain.md); the
`NotifierPort` default-adapter pattern of
[ADR-011](../../adr/011-notifier-port-and-adapters.md)). Swapping in a real processor
is a single provider rebinding plus a new HTTP-doing adapter under
`infrastructure/payment-gateway/` — no use-case change. The port carries no
transport import, so the application layer never depends on a gateway SDK.

## Authorize on place

When Place Order has persisted the order, it authorizes payment inline through the
`AuthorizePaymentUseCase`:

1. Call `PAYMENT_GATEWAY.authorize({ orderId, amountMinor: grandTotalMinor,
   currency, method })`. `method` is the optional opaque payment-method token from
   the request body (a tokenized card, wallet handle, etc.), forwarded verbatim.
2. On approval, construct a `Payment` aggregate via `Payment.authorized(...)` — it
   opens `status = AUTHORIZED` with `capturedAt = null`, storing the gateway's
   opaque `method` and `gatewayReference` tokens (retail never parses them).
3. Persist the `Payment` and advance the order's payment axis with
   `Order.markPaymentAuthorized()` (`paymentStatus: none → authorized`).

After this, the order surfaces three orthogonal statuses — `status = pending`,
`paymentStatus = authorized`, `fulfillmentStatus = unfulfilled` — that evolve
independently ([ADR-028 §2](../../adr/028-cart-order-payment-and-address-chain.md)).
A payment row only ever exists because an authorize succeeded, so its earliest state
is `authorized`; the `none` value lives only on the order's payment **axis**, for the
pre-payment window.

### The non-approval path

The bound fake always approves, so the declined path is unreachable today, but it is
modeled: on `approved = false` the use case leaves the order at
`paymentStatus = none`, persists no `Payment`, and surfaces a typed
`ORDER_PAYMENT_NOT_APPROVED` rejection (HTTP `409`). The order stays placed but
unpaid — a real gateway swap inherits this behavior for free.

## The transaction boundary vs. the out-of-process gateway call

The external `PAYMENT_GATEWAY.authorize` call is an **out-of-process request**, so it
runs **outside** any database transaction — holding a DB transaction open across a
network round trip to a payment processor would pin a connection and a row lock for
the processor's entire latency. The sequence is therefore:

1. **Transaction 1 (Place Order):** persist the `Order` + its lines, the two
   snapshot `Address`es, and the cart conversion atomically (one
   `TRANSACTION_PORT.runInTransaction`, mirroring the inventory `modules/stock`
   transaction adapter — [ADR-017 §6](../../adr/017-architecture-lint-via-eslint-boundaries.md)
   / [ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)). This commits
   first, so the order exists before any payment work.
2. **Gateway call (no transaction):** `authorize(...)` over the wire.
3. **Transaction 2 (Authorize Payment):** a short follow-up transaction persists the
   `Payment` and saves the `Order` with its advanced `paymentStatus` together.

Splitting the writes this way keeps every DB transaction short and never spans the
external call. `AuthorizePaymentUseCase` is its own use case (not inlined into Place
Order) so it is unit-testable against a fake `PAYMENT_GATEWAY` in isolation, and so
the explicit-capture operation can sit alongside it symmetrically.

## Events

After both transactions commit, Place Order emits two best-effort, post-commit wire
events ([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)) — a publish
failure is warn-logged and swallowed, never failing the place:

- `retail.order.placed` → `notification_events` (the consumer's queue; an
  order-confirmation consumer binds with the notification re-point capability).
- `retail.payment.authorized` → `retail_queue` (a reserved surface today).

## Explicit capture

Capture is the second, explicit moment in the policy. Where authorization is automatic
on place, capture is a deliberate operation: `POST /api/orders/:orderId/payments/capture`
walks `Payment.capture(at)` (`authorized → captured`, stamping `capturedAt`) and
advances `Order.markPaymentCaptured()` (`paymentStatus: authorized → captured`).

### Why capture is a separate operation

The default policy in this chain is **authorize-on-place, capture-on-ship**
([ADR-028 §3](../../adr/028-cart-order-payment-and-address-chain.md)): reserve the
funds when the buyer commits, take them when the goods leave. Capturing at place-time
instead would charge a card for stock that might not ship; capturing only ever
automatically would foreclose policies a real merchant needs (authorize-and-cancel, a
manual fraud-review hold, partial capture as items ship). Making capture an explicit,
addressable operation keeps all of those policies *achievable* without rewriting the
place flow — the place flow's only payment responsibility is to authorize. The
walking skeleton ships the manual capture; **ship-triggered automatic capture is a
later fulfillment capability** that will call this same operation, not a new one.

Capture mirrors authorize structurally (the symmetry is deliberate — see *The
transaction boundary* above): the out-of-process `PAYMENT_GATEWAY.capture(gatewayReference)`
call runs outside any DB transaction, and only the two writes that follow — advance
the `Payment`, advance the order's payment axis — run together in a short follow-up
transaction. `amountMinor` defaults to the order's `grandTotalMinor`; partial capture
is a later capability, so the gateway captures the full authorized amount.

### Owner-or-staff authorization — a permission is a *staff override*, not a customer gate

The capture route (and the two read routes that ship with it — Get Order, List My
Orders) is **bearer-protected with an owner-check, and carries no
`@RequiresPermission`** ([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
/ [ADR-028 §7](../../adr/028-cart-order-payment-and-address-chain.md)). This is the
crux: a customer token carries **no `permissions` claim**, so gating the route with
`@RequiresPermission('order:capture')` would lock the owning customer *out of its own
order*. The authorization is therefore split across the boundary:

- The **owner-check** is the base rule, enforced in the retail use case:
  `order.customerId === actorId` (the gateway folds the verified `@CurrentUser().id`
  into `actorId`). A customer may capture (or read) only its own order.
- The **staff override** is computed at the *gateway* from `@CurrentUser().permissions`
  — `isStaffCapture = permissions.includes('order:capture')` for capture,
  `canReadAny = permissions.includes('order:read')` for a read — and forwarded to the
  retail use case as a boolean. The retail use case allows the operation if the
  override is set **or** the caller owns the order, else answers `403`.

So `order:capture` / `order:read` are **staff overrides layered on top of the
owner-check, not customer gates**. A customer always reaches its own order (override
always `false` for it); staff with the code reach *any* order. `order:capture` is
seeded onto the `order-support` role (and `admin`, which holds every code); no
`customer:own-orders:read`-style code exists, because owner-checked customer access is
not permission-modeled at all.

### Idempotent re-capture by payment state

Re-capturing an already-`captured` payment is **idempotent**: the use case returns the
current `captured` state rather than erroring or charging twice. This is the
capture-side analogue of place's cart-state idempotency — just as a placed cart is
`converted` and re-placing it returns the existing order, a captured payment short-
circuits a repeat capture by reading its own state. The `Idempotency-Key` header is
**accepted and logged but not deduped** (Q10); repeat-safety comes from payment state,
not the key (see [08 — Idempotency-Key header](08-idempotency-key-header-q10.md)). A
capture attempt on a payment in any *other* non-authorized state (failed / voided /
refunded) is a `409`.

After a successful capture, a best-effort post-commit `retail.payment.captured` event
is emitted onto `retail_queue` (a reserved surface today, like `retail.payment.authorized`).

## Related documents

- [04 — Order-line snapshots](04-order-line-snapshot-and-cross-service-lookup.md).
- [05 — Payment gateway port and fake adapter](05-payment-gateway-port-and-fake-adapter.md).
- [08 — Idempotency-Key header](08-idempotency-key-header-q10.md).
- [ADR-024 — RBAC v2 (StaffUser/Customer split + the permission model)](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md).
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md).
