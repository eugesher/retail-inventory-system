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

The bound fake always approves, so the declined path is unreachable in practice, but it
is modeled. **The original walking-skeleton behaviour described here — leave the order at
`paymentStatus = none`, persist no `Payment`, surface `ORDER_PAYMENT_NOT_APPROVED` and
let the order "stay placed but unpaid" — was a latent defect and has since been
replaced** (ISSUE-06 /
[ADR-052](../../adr/052-claim-before-you-charge.md)):

Because the authorize runs *after* the place transaction commits, a decline lands on an
order, a `converted` cart and a committed stock allocation that all already exist. Left
unpaid, that order read `pending` / `none` — indistinguishable from a healthy one —
could never ship (Ship refuses an order with no `Payment`), was cancelled by nothing, and
held its stock forever; the customer's retry was handed it as a success. So Place Order now
**compensates** a declined authorization: `compensateDeclinedAuthorization` releases the
allocation (`inventory.cancelAllocation`) and marks the order dead on **both** axes —
`markPaymentFailed()` (`paymentStatus → failed`, the *why*) and `cancel()`
(`status → cancelled`, the *that*). No event is emitted (none ever fired — `emitEvents`
runs after the authorize). The cart stays `converted` deliberately (its CAS is the
double-place guard); the customer starts a new cart.

## The transaction boundary vs. the out-of-process gateway call

The external `PAYMENT_GATEWAY.authorize` call is an **out-of-process request**, so it
runs **outside** any database transaction — holding a DB transaction open across a
network round trip to a payment processor would pin a connection and a row lock for
the processor's entire latency. The sequence is therefore:

1. **Transaction 1 (Place Order):** persist the `Order` + its lines, the two
   snapshot `Address`es, the cart conversion, **and — since
   [ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) — the
   stock allocation** atomically (one `TRANSACTION_PORT.runInTransaction`, mirroring the
   inventory `modules/stock` transaction adapter —
   [ADR-017 §6](../../adr/017-architecture-lint-via-eslint-boundaries.md)
   / [ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)). The `inventory.allocateStock`
   RPC runs **after** the cart-conversion compare-and-swap succeeds (so a double-place loser
   never allocates), turning the cart's holds `reserved → allocated`; an out-of-stock fallback
   rolls the whole place back. This commits first, so the order exists before any payment work.
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
walks the payment `authorized → captured` and advances `Order.markPaymentCaptured()`
(`paymentStatus: authorized → captured`).

> **Since [ADR-052](../../adr/052-claim-before-you-charge.md) that single transition
> is a two-phase claim.** The old one-shot `Payment.capture(at)` was replaced by
> `beginCapture()` (`authorized → capturing`, written **under a `SELECT … FOR UPDATE`
> and committed before the gateway call**) followed by `completeCapture(at)`
> (`capturing → captured`). The committed `capturing` claim is what makes a double charge
> impossible — the loser of a race wakes to find `capturing`, not `authorized`, and is
> refused before it reaches the processor. `ShipFulfillmentUseCase` captures through the
> same path (ADR-031), which is exactly the race this guards.

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

Capture keeps the out-of-process gateway call **outside** any DB transaction (the
authorize-on-place rationale). Since [ADR-052](../../adr/052-claim-before-you-charge.md)
the flow is **three phases**, not one follow-up transaction: (1) `beginCapture()` claims
the authorization under a row lock and **commits** before the gateway is touched; (2)
`PAYMENT_GATEWAY.capture(gatewayReference)` runs holding no lock; (3) a short follow-up
transaction, under the bounded OCC retry, advances the `Payment` (`completeCapture`) and
the order's payment axis (`markPaymentCaptured`) together. A gateway *decline* runs a
fourth short transaction that `releaseCapture()`s the claim back to `authorized`.

`amountMinor` is **not** a partial-capture control and is now **rejected** rather than
silently ignored (ISSUE-09): the gateway always captures the full authorized amount, so an
`amountMinor` that differs from the order's grand total is a `422`
(`PARTIAL_CAPTURE_UNSUPPORTED`) — omit it, or pass the exact grand total. Partial capture
remains an unbuilt capability.

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
current `captured` state rather than erroring or charging twice. This payment-state
idempotency is the capture-side analogue of place's cart-state idempotency — just as a
placed cart is `converted` and re-placing it returns the existing order, a captured
payment short-circuits a repeat capture by reading its own state.

> **The `Idempotency-Key` header is now required and enforced** (ADR-036 — see below),
> not merely "accepted and logged" as the walking skeleton first shipped it. Capture
> fingerprints the canonical body, looks `(scope='capture-payment', key)` up in the
> `IDEMPOTENCY_STORE`, and replays the stored `OrderView` on a same-key/same-body hit
> before any gateway call; a same-key/different-body hit is a `422`, a missing key a
> `400`. Payment-state idempotency remains the backstop underneath it (see
> [08 — Idempotency-Key header](08-idempotency-key-header-q10.md)).

A capture attempt on a payment in any *other* non-authorized state (failed / voided /
refunded) is a `409`.

After a successful capture, a best-effort post-commit `retail.payment.captured` event
is emitted onto `retail_queue` (a reserved surface today, like `retail.payment.authorized`).

## Related documents

- [04 — Order-line snapshots](04-order-line-snapshot-and-cross-service-lookup.md).
- [05 — Payment gateway port and fake adapter](05-payment-gateway-port-and-fake-adapter.md).
- [08 — Idempotency-Key header](08-idempotency-key-header-q10.md).
- [ADR-024 — RBAC v2 (StaffUser/Customer split + the permission model)](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md).
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md).
