# Issue Refund — the gateway `refund()`, the Payment accounting, audit, and idempotency

This document covers the operation that actually moves money back to a buyer: **Issue
Refund**. The data + domain foundation (the `Refund` aggregate, its table, the repository,
the wire enum/view) is described in
[`03-refund-as-distinct-entity.md`](./03-refund-as-distinct-entity.md); this document adds
the pieces that make a refund _issuable_:

- the `PAYMENT_GATEWAY.refund()` extension and the `FakePaymentGatewayAdapter`'s
  always-succeed implementation;
- the `Payment.refund()` mutator — the writer of the `refunded_amount_minor` counter and
  the partial-vs-full status flip;
- the **Issue Refund** use case — preconditions, the gateway call, the `Refund` lifecycle,
  the short follow-up transaction, the always-on audit, and the issued/failed events;
- the **List Refunds** read.

It also serves the **auto-refund-from-cancel** consumer
([`04-auto-refund-from-cancel-order.md`](./04-auto-refund-from-cancel-order.md)), which calls
the same use case directly rather than over RabbitMQ — so both the manual and the automatic
refund paths run through one audited code path.

## 1. The `PAYMENT_GATEWAY.refund()` extension

A refund is a gateway interaction, so it belongs on the **same** `IPaymentGatewayPort` seam
as `authorize` and `capture` (ADR-028 §4). A real payment processor authorizes, captures,
**and** refunds through one integration; modeling refund as a parallel port would split a
single processor across two seams. So the port gains a third method:

```ts
refund(req: IPaymentRefundRequest): Promise<IPaymentRefundResult>;
```

- `IPaymentRefundRequest` carries the **captured** charge's `gatewayReference` (a real
  adapter refunds against the charge it created), the `amountMinor` to return, the
  `currency`, and an optional `correlationId`.
- `IPaymentRefundResult` carries the gateway's `refunded` verdict, a **fresh**
  `gatewayReference` for this refund interaction (distinct from the charge reference — the
  authorize/capture shape), and a `refundedAt` stamp.

The default binding, `FakePaymentGatewayAdapter`, **always succeeds**, minting a
deterministic `fake_refund_<uuid>` reference and taking no money — the always-approve
posture its `authorize` / `capture` already follow. This is what makes the whole refund
flow exercisable end-to-end without a real processor (a real gateway is an excluded
capability). Swapping a real adapter in is a single provider rebinding in
`orders.module.ts` plus an HTTP-doing sibling under `infrastructure/payment-gateway/` —
**no use-case change**. The fake omits the unused request parameter (a real adapter
implements the full arity), the same way its `capture` drops the unused `correlationId`.

## 2. The Issue Refund flow

### Preconditions

1. The order exists (`ORDER_NOT_FOUND`, 404) — it anchors the audit context and the refund
   currency.
2. The payment exists and belongs to the order, else there is no captured money to refund
   (`REFUND_PAYMENT_NOT_CAPTURED`, 409).
3. The payment is **`CAPTURED`** — only captured money can be reversed
   (`REFUND_PAYMENT_NOT_CAPTURED`, 409). An authorized-but-not-captured payment is voided
   by Cancel Order, never refunded.
4. The requested amount fits the **refundable ceiling**
   `payment.amountMinor − payment.refundedAmountMinor` (`REFUND_EXCEEDS_REFUNDABLE`, 409).
   `refunded_amount_minor` is the source of truth for how much is already refunded, so a
   request beyond the remainder — including a replay — can never over-refund.

### The `Refund` lifecycle and the short follow-up transaction

The use case opens the `Refund` `PENDING` and **persists it before** calling the gateway,
so a row exists even if the process dies mid-call. Then:

- **On success** (`refunded: true`), two writes commit together in **one short follow-up
  transaction** (the Capture Payment precedent): `payment.refund(amountMinor)` accumulates
  the counter and flips the status when fully refunded, and `refund.markIssued(...)` walks
  the refund `PENDING → ISSUED` with the gateway's reference + stamp. The gateway call
  itself is **out-of-process**, so — like authorize-on-place and capture — it runs
  _outside_ the transaction; only the two local writes are transactional.
- **On a decline** (`refunded: false`, unreachable with the fake, modeled for a real
  processor), `refund.markFailed()` walks `PENDING → FAILED` (terminal), the `Payment` is
  left **untouched**, and the use case returns the failed view (the operation surfaces the
  outcome rather than throwing — both refund paths can record a decline and move on).

### The `Payment.refund()` accounting

`Payment.refund(amountMinor)` is the writer of the `refunded_amount_minor` counter that
[ADR-028 §6](../../adr/028-cart-order-payment-and-address-chain.md) shipped ahead of any
consumer. The use case validates the request first, so the mutator's guards are
defense-in-depth (an internal-caller bug, not a user-reachable rejection): a positive-int
amount (plain `Error`), a `CAPTURED` payment (`PAYMENT_INVALID_STATUS_TRANSITION`, the
`capture`/`void` transition-guard precedent), and the running total never exceeding the
captured amount (plain `Error`).

Its effect is the **partial-vs-full** decision:

- It accumulates `refundedAmountMinor += amountMinor`.
- If the cumulative total now **equals** the captured amount (a **full** refund), it walks
  `status → REFUNDED` and **clears `flaggedForRefund`** — a full refund settles the flag
  Cancel Order set on a captured-payment cancellation.
- A **partial** refund leaves `status = CAPTURED` and the flag as-is — a captured order may
  still owe more, and a later partial refund completes it (and is the one that flips the
  status).

So `$10` captured can be refunded as `$4` (stays `captured`, `refunded_amount_minor = 400`)
then `$6` (flips to `refunded`, `refunded_amount_minor = 1000`), and a third refund is
rejected by the ceiling.

## 3. Always-audited, retail-side

Refund operations are in the cross-cutting **always-audit** set — money movements are
audited (ADR-032). The audit record is written **retail-side, inside the use case**, not at
a gateway endpoint, for a concrete reason: the auto-refund-from-cancel consumer issues
refunds **without ever crossing the gateway**, so a gateway-side audit would miss every
automatic refund. Writing it inside the one shared use case covers **both** paths.

The use case depends only on the `AUDIT_LOG_PUBLISHER` port (the `IAuditLogPublisher`
contract reused from `libs/contracts/auth`); the retail microservice binds a
`NoOpAuditLogPublisher` (a log-only default mirroring the gateway's) so every refund routes
an audit event to logs today, and a real audit sink swaps in by rebinding — no use-case
change. The record carries the actor, the amount, the reason, and a **before/after snapshot
of the `Payment`** (status + `refundedAmountMinor`), so an auditor sees exactly what moved.
Both the issued and the declined outcomes are audited (a decline records before === after).

The two events round out the surface (best-effort, post-commit, ADR-020):
`retail.refund.issued` rides onto `notification_events` (the buyer-facing
refund-confirmation surface, consumed by the notification service), and
`retail.refund.failed` rides onto `retail_queue` (a reserved surface today, modeled for a
real decline).

## 4. Idempotency

The `Idempotency-Key` header is **accepted + logged but not deduped** — a persisted
idempotency store remains a later capability (the ADR-028 §6 posture). A refund leans on two
guards instead:

- **Gateway-reference natural idempotency + the `refunded_amount_minor` ceiling.** A replay
  that would push the cumulative refunded total past the captured amount is rejected by the
  ceiling, so a replay can never over-refund.
- **The already-issued dedupe match.** Before opening a new refund, the use case looks for an
  `issued` refund with the same `(paymentId, amountMinor, reason)` and, finding one,
  short-circuits to its existing view — making **no** second gateway call. This check runs
  _before_ the captured-precondition, so a **full**-refund replay (the payment is now
  `refunded`, not `captured`) returns the existing refund rather than failing the
  precondition. (A genuinely distinct second partial refund — a different amount or reason —
  is _not_ deduped; it is a new refund, which is the correct behavior for, e.g., two separate
  partial concessions.)

A persisted idempotency-key store would let two truly-identical-key requests with different
amounts collapse to one; that is deferred.

## 5. The List Refunds read

`retail.refund.list` → `ListRefundsForOrderUseCase` resolves an order's refunds newest-first
(`findByOrderId`, ordered `issued_at DESC, id DESC`). Authorization is **owner-or-staff**
`order:read` (ADR-024 / ADR-028 §7): the customer is never permission-gated for its own
order's refunds, while the staff override is folded in at the gateway. A
non-owner-non-staff caller gets **`REFUND_ACCESS_FORBIDDEN`** (403) — the refund surface's
dedicated code, distinct from `ORDER_ACCESS_FORBIDDEN` so the refund reads carry their own
messaging. Issue Refund itself is **staff-only** (`order:refund`), gated at the gateway, so
the use case trusts the resolved `actorId` and does no owner-check.

Both refund RPCs are served by the orders controller (a `Refund` is a sibling aggregate in
the orders module), reachable over RabbitMQ; the gateway HTTP front for `/api/orders/.../refunds`
arrives with the gateway-endpoints capability.

## 6. Related decisions and documents

- [`docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md`](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)
  — the whole returns-and-refunds capability: `Refund`-as-distinct-entity, the
  partial-vs-full accounting, the always-audit rule, and the idempotency posture.
- [`docs/adr/028-cart-order-payment-and-address-chain.md`](../../adr/028-cart-order-payment-and-address-chain.md)
  — the `PAYMENT_GATEWAY` seam, the sibling-aggregate pattern, and the `refunded_amount_minor`
  / `flagged_for_refund` columns shipped ahead of their writer (§4/§6).
- [`03-refund-as-distinct-entity.md`](./03-refund-as-distinct-entity.md) — the `Refund`
  aggregate, table, repository, and why a refund is its own entity.
- [`04-auto-refund-from-cancel-order.md`](./04-auto-refund-from-cancel-order.md) — the
  consumer that issues a refund automatically when Cancel Order flags a captured payment,
  through this same use case.
- [`01-rma-lifecycle.md`](./01-rma-lifecycle.md) — the `ReturnRequest` aggregate whose
  closing return triggers a refund.
