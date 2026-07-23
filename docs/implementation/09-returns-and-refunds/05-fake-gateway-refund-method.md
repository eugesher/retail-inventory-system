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
contract reused from `libs/contracts/auth`). The record carries the actor, the amount, the
reason, and a **before/after snapshot of the `Payment`** (status + `refundedAmountMinor`), so
an auditor sees exactly what moved. Both outcomes are audited under distinct names —
`RefundIssued` and `RefundFailed` — and a decline records before === after.

> **The "swaps in by rebinding" it predicted is exactly what happened, and the rebinding has
> landed.** When this shipped, the retail microservice bound a log-only `NoOpAuditLogPublisher`
> and the audit went nowhere but the logs. That class **no longer exists anywhere in the
> repository**: `orders.module.ts` now binds `AUDIT_LOG_PUBLISHER` to
> `AuditLogRabbitmqPublisher`, which emits the record as the `audit.staff.action` **event**
> onto `ris.events` ([ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)). The
> event-store firehose picks it up and `IngestAuditLogUseCase` writes it to `audit_log_entry` in
> the isolated `ris_eventstore` database ([ADR-034](../../adr/034-isolated-eventstore-database.md)),
> where `GET /api/audit/entries` reads it back
> ([ADR-039](../../adr/039-audit-and-event-store-query-surface.md)). Two details the swap makes
> worth knowing: `audit_log_entry.action` holds the **event name** (`RefundIssued`), never a
> permission code — a `?action=order:refund` filter is a well-formed query that matches nothing.
> And the publisher swallows its own broker failures per ADR-020, which is why the use case can
> `await` the audit without a broker hiccup ever blocking a committed refund. The use case
> itself did not change: that is the point of the port.

The two events round out the surface (best-effort, post-commit, ADR-020):
`retail.refund.issued` rides onto `notification_events` (the buyer-facing
refund-confirmation surface, consumed by the notification service's `RefundEventsConsumer`),
and `retail.refund.failed` rides onto `retail_queue` (a reserved surface today, modeled for a
real decline). Since ADR-035 both are additionally mirrored onto `ris.events`, so the reserved
one is still captured in `domain_event` and queryable — "reserved" means no *business*
consumer, not unobserved.

## 4. Idempotency

The `Idempotency-Key` header is **required, and enforced reserve-first** against the persisted
store [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) shipped. It was
**accepted + logged but not deduped** when this document was written — the ADR-028 §6 posture,
which ADR-036 replaced — and the two natural guards below were the whole defense. They still
run, but they are now the backstop rather than the front line.

### The request-level store — and why refund is the one that reserves

`IssueRefundUseCase.execute` fingerprints the **canonical body** (`orderId`, `paymentId`,
`amountMinor`, `reason` — the transport `correlationId` / `idempotencyKey` and the resolved
`actorId` are deliberately excluded, so the same intent under a fresh correlation id
fingerprints identically) and calls `IDEMPOTENCY_STORE.reserve({ scope: 'issue-refund', key,
requestFingerprint })`. Four outcomes:

| Outcome       | What it means                                          | Answer                                                                                                                                         |
|---------------|--------------------------------------------------------|------------------------------------------------------------------------------------------------------------------------------------------------|
| `replay`      | a **completed** row with a matching fingerprint exists | the stored `RefundView`, `200` + `Idempotent-Replay: true` — **no gateway call, no audit row, no events**                                      |
| `mismatch`    | one key reused for a different body                    | `422 ORDER_IDEMPOTENCY_KEY_REUSED`                                                                                                             |
| `in-progress` | a concurrent submit holds the key and is mid-refund    | `409 ORDER_IDEMPOTENCY_KEY_IN_PROGRESS`                                                                                                        |
| `reserved`    | this call won the INSERT                               | it owns the execution; `finalize`s the row with the captured response afterwards, or `release`s it on failure so a legitimate retry can re-run |

A missing key is `400 ORDER_IDEMPOTENCY_KEY_REQUIRED`. Every legitimate caller supplies one —
the HTTP route forwards the client header, and the auto-refund-from-cancel consumer synthesizes
a deterministic one — so that branch fires only for something talking to the bus directly, and
refusing it is the point.

**Why *reserve*-first, when place / capture / ship merely `find → work → save`.** Those three
each have a *second* serializing guard — the cart-conversion CAS, the payment-state check plus
the order OCC, the ship `SELECT … FOR UPDATE` — so a redundant concurrent run is at worst a
benign repeat, and the composite-PK collision on `save` dedups the stored response afterwards.
**Refund has no such second guard, and a gateway refund is not naturally idempotent.** A plain
`find → refund → save` would let two truly concurrent same-key submits *both* refund before
either recorded the key. So the pending-row INSERT claims `(scope, key)` **before** the gateway
call — the notification-delivery persist-before-the-side-effect precedent
([ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md)). The
`response_status` / `response_body` columns are nullable precisely so a pending row can exist.

One ordering detail carries real weight: **a replay returns before the audit emit.** One logical
refund writes exactly one `audit_log_entry` no matter how many times the client retries.

### The two natural guards, still in place

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

This paragraph originally closed with *"a persisted idempotency-key store would let two
truly-identical-key requests with different amounts collapse to one; that is deferred."* It is
no longer deferred, and the store does **not** collapse them — it **rejects** the second with
`422`. Same key, different body is a client bug, surfaced rather than silently honoured.

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
the orders module), reachable over RabbitMQ. The gateway HTTP front for
`/api/orders/:orderId/refunds` **arrived later in this same epic** — see
[`06-returns-and-refunds-api-and-http-files.md`](./06-returns-and-refunds-api-and-http-files.md),
which adds `RefundsController` alongside the existing orders controller.

One signature note the store changed: `IssueRefundUseCase.execute` no longer resolves a bare
`RefundView`. It resolves an **`IIdempotentResult<RefundView>`** — `{ view, replayed }` — so the
gateway controller can answer `201 Created` on a fresh issue and `200 OK` +
`Idempotent-Replay: true` on a replay. `ListRefundsForOrderUseCase` is unchanged and still
resolves a plain `RefundView[]`.

## 6. Related decisions and documents

- [
  `docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md`](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)
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
