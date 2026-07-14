# ADR-052: Claim before you charge — an irreversible effect needs a durable claim, not a check

- **Date**: 2026-07-13
- **Status**: Accepted

---

## Context

Two code paths take money. Both did it the same wrong way.

```ts
// capture-payment.use-case.ts — and, identically, ship-fulfillment.use-case.ts
const payment = await this.paymentRepository.findByOrderId(orderId);   // an UNLOCKED read
if (payment.status !== PaymentStatusEnum.AUTHORIZED) { throw ... }     // the guard
const result = await this.paymentGateway.capture(payment.gatewayReference);  // MONEY MOVES
await runWithOrderWriteRetry(() => transactionPort.runInTransaction(async (scope) => {
  const fresh = await this.paymentRepository.findByOrderId(orderId, scope);  // NOW re-read
  fresh.capture(result.capturedAt);                                    // throws if not AUTHORIZED
}));
```

**The precondition that requires the lock is verified after the money has already moved.**

Two callers — an explicit `POST /payments/capture` and the ship-triggered capture inside
`POST /fulfillments/:id/ship` — both pass the unlocked `AUTHORIZED` check, both charge the processor,
and the loser then throws `PAYMENT_INVALID_STATUS_TRANSITION` and rolls its transaction back. **The
database records one capture and one clean 409. The rollback cannot un-call a payment gateway.**

Ship had a second victim. A concurrent Cancel landing in the same window read the payment as still
`AUTHORIZED` — because the ship's capture had not committed — **voided it, and cancelled the order.**
The customer is charged, the order is cancelled, and the row says `VOIDED`. **Nothing in the system
knows there is anything to reconcile.**

### The race window is not narrow. It is the width of a round-trip to a payment processor.

That is not an accident of the code; it is the code's shape. The gateway call is *what sits inside the
window*. Hundreds of milliseconds, by construction.

### The comments were not careless, and that is the finding

> *"The gateway `capture` above ran ONCE, outside the loop — **a retry never re-charges**."*

**True.** And it is about a *retry*. The hazard is a **concurrent caller**.

> *"Validate the tracking-on-ship policy BEFORE the out-of-process capture, so the ship is never
> blocked AFTER taking the money … **hoisted to avoid a capture-then-fail hole**."*

**It names the hazard exactly and closes half of it.** `trackingNumber` is a payload check and hoists
cleanly. **Status cannot be hoisted** — it is only true under the lock, and the lock comes after the
charge.

Each author understood the mechanism and stopped one step short. They guarded the retry and missed the
concurrent caller; they hoisted the precondition that *could* be hoisted and did not notice the one
that could not. **A local fix per site would have reproduced exactly this**, which is why this is an
ADR and not two bug fixes.

### The repository already had the answer, and had used it once

`IssueRefundUseCase` — fifty lines away, same module, same gateway — **writes a durable `PENDING`
`Refund` row before calling the gateway**, and `RefundStatusEnum`'s own comment says why: *"the row is
created before the call, **deliberately, so a crash mid-flight leaves evidence rather than silence**."*

`price.open_scope_key` and `notification_delivery.delivery_dedupe_key` are the same instinct at the
schema level. **The practice is not missing. It was unevenly applied** — and the paths it was missing
from were the two that move money.

## Decision

> **An irreversible external effect must be preceded by a durable, visible claim, committed before
> the effect, and followed by a designed path that resolves it.**
>
> **A check performed on an unlocked read is not a guard.** It narrows a window; it does not close
> one. **No comment may describe such a check as making an operation safe.**

### The claim: `PaymentStatusEnum.CAPTURING`

One new status — **the only non-terminal one on `Payment`**. Both capture paths now:

1. **Claim.** A short transaction: `findByOrderIdForUpdate` (a `SELECT … FOR UPDATE`, a **CURRENT**
   read), assert `AUTHORIZED`, `beginCapture()` → `CAPTURING`, **commit**.
2. **Charge.** The gateway call, out of process, **holding no lock**.
3. **Resolve.** `completeCapture()` → `CAPTURED` on approval; `releaseCapture()` → `AUTHORIZED` on a
   decline (the one case where we *know* no money moved).

The loser of a race **blocks on the row**, wakes to find `CAPTURING` instead of `AUTHORIZED`, and
`beginCapture()` rejects it — **before it reaches the processor**. The 409 it gets is the same code as
before, raised at the only moment it is worth anything: while the money is still the customer's.

**Cancel Order refuses a `CAPTURING` payment** (`ORDER_NOT_CANCELLABLE`). This is not a detail — it is
what makes the claim worth having. Without it the claim would be a status nobody honoured.

### Why `Fulfillment` needs no claim of its own

The obvious design adds a second claim — a `shipping` fulfillment status — so that a cancel cannot
cancel a fulfillment out from under a ship that is mid-charge. **It is unnecessary, and the reason is
worth stating because it is not obvious.**

The only thing that can move a `pending` fulfillment during that window is a Cancel, and **Cancel is
already blocked by the payment claim.** So the `pending` check the ship made under its claim lock
*stays true across the gateway round-trip* — which is precisely what it could not do before. A second
enum member, a second migration and a second set of `switch` sites buy nothing the payment claim does
not already buy.

*(If a future path can move a fulfillment off `pending` **without** touching the payment, that
reasoning breaks and the fulfillment claim becomes necessary. It is the invariant to check before
adding one.)*

### The stranded claim is reported, never resolved

A crash between the claim and the resolution leaves a `CAPTURING` row. **Nobody knows whether the
money moved**, and `IPaymentGatewayPort` offers `authorize` / `capture` / `refund` and **no way to
ask**.

`ReportStaleCaptureClaimsUseCase` surfaces such rows at `error`, with the `gatewayReference` an
operator needs, and **writes nothing**:

- **Releasing** the claim to `AUTHORIZED` would let the next caller charge again — *recreating the
  double charge this mechanism exists to prevent, deliberately.*
- **Completing** it to `CAPTURED` would record money that may never have moved.

**There is no safe automatic answer, so the system does not invent one.** It is named `Report…`, not
`Sweep…`, so nobody adds a fix-it branch by analogy with `SweepExpiredReservationsUseCase` — that one
releases holds on *stock*, where a wrong guess costs availability. This guards *money*, where a wrong
guess charges a customer twice. A unit test pins the **inaction**.

### `amountMinor` is rejected, not ignored (ISSUE-09, folded in)

The same route accepted an optional `amountMinor`, validated it, forwarded it over RPC — **and dropped
it**. `IPaymentGatewayPort.capture(gatewayReference)` takes no amount. A client asking to capture
`1000` against a `29997` order was **charged in full and got a `200` that contradicted nothing**. The
`Idempotency-Key` did not save them either: the fingerprint hashes the body, so a "retry with a smaller
amount" is a *different key* and a fresh full charge.

Now a mismatch is `422 PARTIAL_CAPTURE_UNSUPPORTED`, and **the Swagger description says so** — the one
artefact an external integrator reads, on the one route where being wrong moves money, and one they
cannot check against the source. **Leaving that description stale was the defect, not a side-effect of
it.**

## Consequences

### Positive

- **One authorization cannot be charged twice.** Proved by a spy that counts gateway calls
  (`test/concurrent-capture-double-charge.e2e-spec.ts`) — **two** on the parent commit, **one** now.
- **A cancel can no longer take the money and ship nothing.** The impossible state is now impossible.
- **A crash mid-charge leaves evidence.** It used to leave silence.
- **The rule is stated once**, where "irreversible" is the operative word — so the next path that
  calls an external effect inherits it instead of re-deriving it.

### Negative

- **A concurrent ship of a *different* fulfillment on the same order can get a transient 409** while a
  capture is in flight, because it contends for the one payment claim. It resolves in a round-trip and
  a retry succeeds. Judged the right trade: the alternative is a per-fulfillment claim whose only job
  is to make a rare 409 rarer.
- **A new non-terminal state exists, and it can strand.** That is the honest price of the guarantee —
  and `Refund` has been paying it since ADR-032.
- **`down()` on the migration refuses while any claim is open.** Narrowing the ENUM would coerce those
  rows to garbage, and neither `authorized` nor `captured` is a safe guess. A revert now requires a
  human to resolve them first, which is correct and inconvenient.

### Open

- **`IPaymentGatewayPort` has no way to ask whether a capture landed.** Every real processor offers
  one, and the day a real gateway is bound is the day `ReportStaleCaptureClaims…` could become a true
  reconciler. **Until then, do not make it guess.**
- **Nothing enforces the rule.** No lint catches an out-of-process call made before the claim; it is an
  ADR and a code review. The same open item ADR-049 and ADR-051 already carry.
- **`PaymentStatusEnum.FAILED` still has no producer.** A declined capture releases the claim rather
  than failing the payment; the member remains a shape with no path to it.

## Alternatives considered

- **Move the capture inside the transaction, after `findByIdForUpdate`.** The simplest fix, and the one
  most likely to be regretted: it holds a DB row lock across the public internet for the processor's
  latency. `place-order` *does* hold its transaction across the inventory RPC and **earns it** — the
  comment says why: in-cluster, disjoint tables, bounded. **A payment gateway is none of those three.**
  It also leaves the crash case exactly as bad: die after the charge and before the commit, and the
  database has no idea the money moved.
- **Capture, and refund on a failed ship.** A compensating transaction — the partial saga ADR-031
  explicitly set out to avoid. It also assumes the refund succeeds.
- **An idempotency key on the gateway `capture` call.** How real integrations solve this, and a good
  idea *in addition*. It is not a substitute: it relies on a capability the port does not model and the
  bound adapter does not have, and it does nothing about the cancel-voids-a-captured-payment hole.
- **A `shipping` claim on `Fulfillment` as well.** Rejected — see above. It is the design the issue
  proposed, and it buys nothing the payment claim does not already buy.
- **Fix ISSUE-07 alone (or ISSUE-05 alone).** Rejected on principle. They race *each other*; fixing one
  leaves the race live, and fixing them separately produces two shapes for one hazard — which is how
  the codebase arrived here.

## References

- [ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) — block-ship-until-payment-succeeds.
  **This ADR makes ADR-031 true; it does not reverse it.** ADR-031 chose that rule *precisely* to have
  no partial saga and nothing to reconcile. The decision was sound; the implementation did not achieve
  it, because it treated "capture before the commit" as equivalent to "capture after all
  preconditions", and one precondition was not knowable until the lock was held.
- [ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md) — `Refund`'s `PENDING` row: the
  in-repo reference implementation of this rule, and the one the two capture paths did not copy.
- [ADR-036](036-idempotency-key-store-and-enforced-occ.md) — the `Idempotency-Key`, which **does not help
  here**: the racing operations are different requests with different scopes (`'ship-fulfillment'` vs
  `'capture-payment'`), and the store is right not to conflate them.
