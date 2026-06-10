# 07 — Authorize on place, capture explicit

Payment in this checkout chain splits into two distinct moments: **authorization**
happens automatically when an order is placed, and **capture** is a separate,
explicit operation performed later. This is the common storefront default —
authorization reserves the funds the moment the buyer commits, while capture (taking
the money) is deferred to an operator/fulfillment action
([ADR-028 §3](../../adr/028-cart-order-payment-and-address-chain.md)). This document
covers the **authorize-on-place** half; the **explicit capture** half is completed
by the order read/capture capability (see the marked section at the end).

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

## Explicit capture — completed by the read/capture capability

> **This section is a placeholder.** Capture is the second, explicit half of Q5: an
> operator action that walks `Payment.capture(at)` (`authorized → captured`, stamping
> `capturedAt`) and advances `Order.markPaymentCaptured()`
> (`paymentStatus: authorized → captured`). It is gated by a staff `order:capture`
> permission (customers do not capture their own orders). Ship-triggered
> auto-capture is a later fulfillment capability, not part of this chain
> ([ADR-028 §3](../../adr/028-cart-order-payment-and-address-chain.md)). The domain
> already supports it (`Payment.capture` and `Order.markPaymentCaptured` exist); this
> document is completed when the capture operation + its gateway endpoint land.

## Related documents

- [04 — Order-line snapshots](04-order-line-snapshot-and-cross-service-lookup.md).
- [05 — Payment gateway port and fake adapter](05-payment-gateway-port-and-fake-adapter.md).
- [08 — Idempotency-Key header](08-idempotency-key-header-q10.md).
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md).
