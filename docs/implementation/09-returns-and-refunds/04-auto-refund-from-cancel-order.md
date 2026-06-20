# Auto-refund from a cancelled order

Cancelling an order whose payment was already **captured** must give the buyer their money
back. Cancel Order does the *settlement bookkeeping* — it marks the captured payment as
owing a refund and announces the cancellation — but it deliberately does **not** move the
money itself. This document covers the piece that closes that loop: a retail consumer that
reacts to the cancellation event and issues the refund automatically.

The refund mechanics themselves (the gateway call, the `Payment` accounting, the audit, the
events) live in the shared Issue Refund use case, described in
[`05-fake-gateway-refund-method.md`](./05-fake-gateway-refund-method.md). This consumer is a
**trigger** for that use case, not a second implementation of it.

## 1. The flag handshake

Two halves implement one cross-cutting rule — _"a captured order that gets cancelled gets
refunded"_ — and they are deliberately split across a commit boundary.

**The writer half — Cancel Order** (see
[ADR-031](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)). When an order
with a **captured** payment is cancelled, the use case settles the payment by calling
`Payment.flagForRefund()`, which sets `payment.flagged_for_refund = true`. It commits that
(plus the order/​fulfillment cancellation) in one local transaction, then emits
`retail.order.cancelled` carrying a boolean **`paymentFlaggedForRefund`**. The flag on the
row and the boolean on the event say the same thing: _money was captured and is now owed
back_. An **authorized**-but-not-captured payment is **voided** instead — no money ever
moved — and the event's `paymentFlaggedForRefund` is `false`.

Crucially, Cancel Order **stops there**. It does not call the gateway to refund inline,
because the refund is a separate out-of-process interaction that should not be able to roll
the cancellation back or block its commit. The flag is the durable handoff: the cancellation
is final regardless of what happens to the refund next.

**The reader half — `OrderCancelledConsumer`** (this document). It subscribes to retail's
**own** `retail.order.cancelled` event (the producer emits it onto `retail_queue`, the
service's own queue, and now this `@EventPattern` consumes it there — the
producer-targets-consumer-queue routing of
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md) /
[ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md)). It branches on
`paymentFlaggedForRefund`:

- **`false`** → a pre-capture cancellation voided the authorization (or there was no
  payment). Nothing was taken, so nothing is owed. The consumer logs the `correlationId`
  inline and returns. (`@EventPattern` handlers are not request-scoped, so the correlation
  id rides in the log object — `PinoLogger.assign()` would throw outside a request,
  [ADR-011 §7](../../adr/011-notifier-port-and-adapters.md).)
- **`true`** → resolve the order's captured `Payment` (`PAYMENT_REPOSITORY.findByOrderId`),
  compute its still-refundable remainder `amountMinor − refundedAmountMinor`, and — if that
  is `> 0` — issue a **full** refund for the remainder by calling `IssueRefundUseCase`
  with `reason: 'order-cancelled'` and `actorId: null` (system-initiated; see §3).

So the two halves never share a transaction or a process call: Cancel Order writes the flag
and the event; the consumer reads them and moves the money. If the consumer's refund fails,
the flag is still set, and a later manual refund or a redelivery settles it (§3).

## 2. Why a captured order can be cancelled at all

It is worth being explicit about _which_ cancellation reaches the flagged path, because the
order lifecycle makes it narrow.

Cancel Order **rejects** an order that has any `shipped` or `delivered` fulfillment
(`ORDER_NOT_CANCELLABLE`, 409 — ADR-031). Stock that has physically left the warehouse is
not unwound by a cancel; that is the returns/RMA flow's job. So the only way to reach Cancel
Order with a **captured** payment is the window where the payment was captured **but nothing
has shipped yet**:

1. Place Order authorizes the payment (status `authorized`).
2. A staff caller captures it **explicitly** via `POST /api/orders/:id/payments/capture`
   (the payment row goes `captured`) — _without_ shipping. (The usual path captures *at
   ship* time, but ship then blocks the cancel, so that path never reaches here.)
3. Cancel Order now runs on a `pending`/`captured`/`unfulfilled` order: it flags the
   captured payment for refund and emits the event with `paymentFlaggedForRefund = true`.

This is the **cancel-after-explicit-capture-before-ship** path, and it is exactly the
scenario an end-to-end test of this feature must construct (place → capture → cancel, never
ship). Every other cancellation either has no captured payment (authorized → voided, flag
`false`) or is blocked outright (shipped → `ORDER_NOT_CANCELLABLE`).

## 3. Inline consumer vs background worker

The refund could be driven by a standalone background worker polling for flagged payments.
This baseline chooses an **inline-in-retail consumer** instead, for three reasons:

- **It reuses the one audited code path.** `IssueRefundUseCase` already owns the
  preconditions, the gateway call, the `Payment.refund()` accounting, the always-on audit,
  and the issued/​failed events. The consumer calls it **directly** (not back over
  RabbitMQ), so the automatic and the manual refund paths run through exactly one
  implementation — no divergence, no second place to keep the accounting correct.
- **No new deployable, no cross-service hop** ([ADR-018](../../adr/018-nestjs-monorepo-apps-and-libs.md)).
  The event already lands on `retail_queue`; reacting to it inside the retail service is the
  smallest possible surface. A separate worker would add a process to operate and a polling
  cadence to tune for no extra capability.
- **Idempotency falls out of the accounting — no job table.** This is the key reason a
  worker's bookkeeping is unnecessary.

### Idempotency via the refundable-amount guard

RabbitMQ is at-least-once ([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)): the
same `retail.order.cancelled` can be delivered more than once. The consumer must tolerate
that **without** a processed-message store. It does, because the refund accounting is
self-describing:

- The first delivery issues a full refund. `Payment.refund()` accumulates
  `refunded_amount_minor` until it equals the captured `amount_minor`, at which point the
  payment flips to `refunded` and the `flagged_for_refund` flag is **cleared**.
- A **redelivery** recomputes `refundable = amountMinor − refundedAmountMinor`, which is now
  `0`. The consumer's `> 0` guard makes it a **no-op** — no gateway call, no new refund row.

No new state is needed; the idempotency is a direct consequence of the payment-row counter
that the [shared Issue Refund accounting](./05-fake-gateway-refund-method.md) maintains. (`IssueRefundUseCase` carries its own already-issued short-circuit too — an
`issued` refund for the same `(paymentId, amountMinor, reason)` returns without a second
gateway call — so even a near-simultaneous duplicate is safe.)

### System actor and best-effort posture

The consumer calls the use case with **`actorId: null`**. There is no human caller; the
audit contract (`IAuditLogEvent.actorId: string | null`) already models a null actor as a
system / pre-auth movement, so the two refund paths share one use case without inventing a
sentinel id. `reason: 'order-cancelled'` records _why_ on the `refund` row and the audit log,
distinguishing an automatic cancel-refund from a staff-initiated one.

A downstream failure (a gateway hiccup, a transient DB error) is **warn-logged and
swallowed** — the handler never throws. The cancellation has already committed, and a failed
auto-refund leaves the payment `flagged_for_refund`, which is precisely the flag's purpose:
the money is still owed, visibly, and a later manual refund or a redelivery can settle it.
Throwing would only NACK and redeliver to no benefit, and once the refund does succeed the
guard above makes any redelivery a no-op.

## 4. Related decisions and documents

- [`docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md`](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)
  — the returns-and-refunds capability, including the auto-refund-from-cancel design
  (inline-in-retail, not a separate microservice) and the always-audit rule.
- [`docs/adr/031-fulfillment-aggregate-and-ship-triggered-capture.md`](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)
  — Cancel Order, the `flagged_for_refund` writer, and the `retail.order.cancelled` event
  carrying `paymentFlaggedForRefund` (the handshake's writer half).
- [`05-fake-gateway-refund-method.md`](./05-fake-gateway-refund-method.md) — the shared
  Issue Refund use case this consumer triggers: the gateway `refund()`, the `Payment.refund()`
  accounting, the audit, and the natural idempotency.
- [`03-refund-as-distinct-entity.md`](./03-refund-as-distinct-entity.md) — the `Refund`
  aggregate and why a refund is its own entity, separate from a return.
</content>
