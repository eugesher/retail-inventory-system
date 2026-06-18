# Ship-triggered capture and the cross-service decrement

This document explains **when and how shipping a fulfillment takes the money**, and the
two failure modes that bracket a ship — a capture that the payment gateway declines, and
a cross-service inventory decrement that fails after the ship has committed. It is the
payment-and-consistency companion to
[02-create-and-ship-fulfillment.md](02-create-and-ship-fulfillment.md), which covers the
fulfillment mechanics (preconditions, the tracking-number policy, the status roll-up).

The operation is `retail.fulfillment.ship` → `ShipFulfillmentUseCase`, in the retail
`orders/` module.

## 1. The policy: ship-triggered automatic capture (Q5)

The checkout payment flow is **authorize-on-place, capture-on-ship**. Placing an order
authorizes the payment (reserves the funds) but does not take them; the money is captured
later. The default policy for *when* capture happens is **ship-triggered automatic
capture**: capturing the payment is a side effect of shipping the goods, not a separate
manual step the operator must remember.

This is the natural default — you take the customer's money at the moment you actually
send them their goods. An explicit, standalone capture
([`CapturePaymentUseCase`](../../../apps/retail-microservice/src/modules/orders/application/use-cases/capture-payment.use-case.ts),
`retail.payment.capture`) still exists for the cases that need it (capturing before
shipment, or capturing an order that ships in a channel the system does not drive), which
is exactly why the place flow deliberately stops at *authorize* and leaves capture to a
later operation rather than capturing inline at place-time. Ship-triggered capture builds
on that seam — it reuses the same `PAYMENT_GATEWAY.capture` port the explicit capture
uses.

## 2. The conditional auto-capture

When a ship runs, it inspects the order's single `Payment` row and branches on its status:

- **`authorized` → capture inline.** The ship calls `PAYMENT_GATEWAY.capture(payment.
  gatewayReference, correlationId)`. On approval it records the capture: in the ship's
  local transaction it walks the `Payment` `authorized → captured` (`payment.capture(at)`)
  and the order's payment axis `authorized → captured`
  (`order.markPaymentCaptured()`), and after the commit it emits
  `retail.payment.captured` (reusing the explicit-capture event — a ship-triggered capture
  is still a capture).
- **`captured` → skip the gateway.** An explicit capture already happened earlier, so the
  money is already taken. The ship makes **no** second gateway call and emits no captured
  event; it just commits the fulfillment and moves the stock.
- **any other status** (`voided` / `refunded` / `failed`) **→ reject `409`**
  (`PAYMENT_INVALID_STATUS_TRANSITION`). There is nothing capturable, so the ship cannot
  proceed.

### The exact ordering

The sequence is the consistency-critical part of the whole operation:

```
1. authorize + load          (order, fulfillment, payment) — no writes
2. validate preconditions    (fulfillment pending, tracking present)   ← before any side effect
3. CAPTURE  (if authorized)  PAYMENT_GATEWAY.capture — out-of-process, BEFORE the local commit
4. LOCAL TRANSACTION         fulfillment.ship + payment.capture(at) + order.markPaymentCaptured
                             + each OrderLine.markFulfillment + order.advanceFulfillment
5. COMMIT SALE               inventory.stock.commit-sale — cross-service, AFTER the local commit
6. EMIT                      retail.fulfillment.shipped (+ retail.payment.captured when captured)
```

Two ordering rules carry the design:

- **Capture runs _before_ the local commit** (step 3 before step 4). The gateway call is
  an out-of-process side effect, so it must not sit inside the database transaction (a
  long network call holding row locks; a rollback cannot un-capture money). This mirrors
  the explicit `CapturePaymentUseCase`, which captures out-of-process and then advances
  the rows in a short follow-up transaction. It is also why the tracking-number
  precondition (step 2) is hoisted *before* the capture — a ship that would fail its own
  precondition must fail before any money moves, never after.
- **Commit Sale runs _after_ the local commit** (step 5 after step 4). The physical stock
  decrement is a second service's write; making it part of the retail transaction would
  require a distributed transaction. Instead the retail ship commits first, then calls
  Commit Sale, accepting eventual consistency on the inventory decrement (§4).

## 3. If the capture fails: block ship until payment succeeds

If the gateway **declines** the capture (step 3), the ship **aborts** with
`ORDER_PAYMENT_NOT_CAPTURED` (`409`). Because the capture runs *before* the local
transaction, nothing has been written: the fulfillment is still `pending`, the order's
axes are untouched, no Commit Sale fires, no event is emitted. The order is left exactly
as it was, and an operator retries the ship once the payment problem is resolved.

This is the **block-ship-until-payment-succeeds** compensation — deliberately the
*simpler* stance:

- **There is no `pending-with-payment-failure` intermediate state** to model, persist,
  surface in views, or reconcile. The fulfillment status axis stays
  `pending`/`shipped`/`delivered`/`cancelled`; payment failure is not one of its values.
- **There is no partial saga to unwind.** Capture-before-commit means a decline aborts
  with zero writes — there is no fulfillment transition or stock decrement to compensate.

### Alternatives rejected

- **A full saga with an order-level rollback / a `payment-failed` state.** Rejected as
  premature machinery: it buys a reconciliation worker, a new exposed status value, and
  compensating actions to handle a case that the capture-before-commit ordering makes
  *impossible to reach with partial state*. For a single-capture-per-ship flow the simple
  block is correct.
- **Ship first, capture asynchronously afterward** (let the goods leave on an authorized
  payment, capture later out of band). Rejected: it ships goods you may never get paid
  for, turning a synchronous "did the money move?" answer into an asynchronous
  reconciliation problem — the opposite trade-off from §4's inventory decrement, where the
  money is *already taken* and only the warehouse bookkeeping lags.

## 4. If Commit Sale fails after the local commit

Commit Sale (`inventory.stock.commit-sale`, reached through the module-prefixed
`ORDER_COMMIT_SALE_GATEWAY` port) runs **after** the local ship has committed. By then the
money is captured and the box has physically left — so a hiccup in the asynchronous
inventory decrement must **not** roll the ship back. The handling is:

- **Transient failure → bounded retry.** The use case retries the RPC a small, fixed
  number of times (`COMMIT_SALE_MAX_ATTEMPTS`). The realistic failure is a transient
  RabbitMQ timeout that the broker recovers from, so an immediate retry usually succeeds.
- **Hard / persistent failure → log and move on.** If the retries are exhausted, the use
  case logs the **full Commit Sale payload at `error`** — a poison record an operator can
  replay by hand — and returns normally. The ship is **not** rolled back.

What makes this safe is that **Commit Sale is idempotent on `fulfillmentId`**: inventory
records one strictly-negative `sale` `StockMovement` per shipment keyed by
`(reference_type='fulfillment', reference_id=fulfillmentId)`, and a replay that finds an
existing row decrements nothing and re-returns the prior result (see
[04-commit-sale-cross-service-rpc.md](04-commit-sale-cross-service-rpc.md) and
[06-stockmovement-sale-type.md](06-stockmovement-sale-type.md)). So a retry — automatic or
a manual operator replay hours later — can never double-decrement stock.

### Why not roll the ship back on a Commit Sale failure?

Rolling the local ship back because an asynchronous inventory decrement failed would mean
un-shipping a box that has left and un-capturing money that is taken — strictly worse than
a brief window where the retail records say "shipped" and the inventory `quantity_on_hand`
has not yet dropped. The running totals are the inventory balance authority and the
`sale` ledger row is the audit trail
([ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)); an
eventually-consistent, idempotent retry reconciles them without a distributed transaction.

## 5. References

- [ADR-031 — Fulfillment aggregate and ship-triggered capture](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)
  — the decision this document implements (Q5 ship-triggered capture, block-ship
  compensation, the Commit Sale seam and its `fulfillmentId` idempotency).
- [ADR-028 — Cart, Order, Payment, and Address chain](../../adr/028-cart-order-payment-and-address-chain.md)
  — authorize-on-place / capture-explicit, the three orthogonal order axes, the
  `PAYMENT_GATEWAY` port and `TRANSACTION_PORT`.
- [02-create-and-ship-fulfillment.md](02-create-and-ship-fulfillment.md) — the fulfillment
  mechanics (preconditions, tracking-number policy, the partial-vs-full status roll-up).
- [04-commit-sale-cross-service-rpc.md](04-commit-sale-cross-service-rpc.md) — the
  inventory side of Commit Sale: the all-lines-atomic decrement and the `fulfillmentId`
  idempotency this document relies on.
- [06-stockmovement-sale-type.md](06-stockmovement-sale-type.md) — the `sale`
  `StockMovement` ledger type Commit Sale produces.
