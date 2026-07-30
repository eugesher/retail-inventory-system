# Mark Delivered, Cancel Order, and Cancel Line

This document explains the three remaining order-lifecycle transitions of the ship flow —
the happy-path terminal (**Mark Delivered**), the pre-fulfillment unhappy terminal
(**Cancel Order**), and the line-level partial cancel (**Cancel Line**). They are the
counterpart to the forward motion described in
[02-create-and-ship-fulfillment.md](02-create-and-ship-fulfillment.md) and
[03-ship-triggered-capture-q5.md](03-ship-triggered-capture-q5.md): where Create plans a
shipment and Ship takes the money and moves the stock, these operations either close an
order out as delivered or unwind it (settling the payment the other way and releasing the
stock back to `available`).

All three live in the retail `orders/` module, served over RabbitMQ and fronted over HTTP
under `/api/orders` by the gateway `modules/orders/` (see
[07-fulfillment-http-files.md](07-fulfillment-http-files.md)).

| Operation      | Routing key                  | Use case               | Returns           |
|----------------|------------------------------|------------------------|-------------------|
| Mark Delivered | `retail.fulfillment.deliver` | `MarkDeliveredUseCase` | `FulfillmentView` |
| Cancel Order   | `retail.order.cancel`        | `CancelOrderUseCase`   | `OrderView`       |
| Cancel Line    | `retail.order.cancel-line`   | `CancelLineUseCase`    | `OrderView`       |

The shared machinery is small and deliberate: the order/payment/fulfillment domain
mutators (`Order.cancel`, `Order.markDelivered`, `Payment.void`, `Payment.flagForRefund`),
the existing `inventory.allocation.cancel` allocation-release seam (ADR-030), and the
owner-or-staff authorization helper (`loadAuthorizedOrder`). Because they share that
machinery they ship as one unit.

## 1. Cancel Order

`CancelOrderUseCase` cancels an order **that has not yet shipped**. It is the mirror of
Ship: Ship captures the payment and decrements physical stock; Cancel voids/flags the
payment and releases the allocated stock.

### Preconditions — no physically-shipped stock can be stranded

The hard precondition is: **the order must have no `shipped` or `delivered`
fulfillment**. If one exists, the cancel is rejected with `ORDER_NOT_CANCELLABLE` (409).
The rationale is concrete — a shipped box is gone; cancelling its order would strand the
stock it physically carried (the allocation has already been decremented to a `sale` by
Commit Sale). `pending` fulfillments are fine: they are planned but not shipped, so they
are simply cancelled along with the order (a `Fulfillment` status flip
`pending → cancelled`, never a row delete).

There is a subtlety worth stating plainly, because it is *why the precondition is a
use-case check and not a domain guard*. After a ship, the order's **lifecycle** axis stays
`pending` — Ship advances only the order's *fulfillment* axis (`partially-shipped` /
`shipped`), never the lifecycle axis (there is no confirm-on-ship in this capability). So
the domain mutator `Order.cancel()`, which guards `pending|confirmed → cancelled`, would
*happily* cancel an order that had already shipped — its lifecycle is still `pending`. The
real guard is therefore the **fulfillment-presence check** in the use case
(`FULFILLMENT_REPOSITORY.listByOrderId`, reject if any is `shipped`/`delivered`); the
domain `Order.cancel()` is the lifecycle backstop that catches an already-`cancelled`,
`shipped`-lifecycle, or `delivered` order.

> **A second refusal has since joined it: a payment capture in flight.** Under
> [ADR-052](../../adr/052-claim-before-you-charge.md) a ship (or an explicit capture)
> commits a `CAPTURING` claim on the `payment` row *before* it charges the processor, and
> Cancel Order **refuses a `CAPTURING` payment** with the same `ORDER_NOT_CANCELLABLE`
> (409). This is not a detail — it is what makes the claim worth having. `CAPTURING` means
> a caller may already have taken the money and there is no way to ask whether it landed
> (`IPaymentGatewayPort` offers `authorize`/`capture`/`refund` and nothing to query with).
> Voiding here would reproduce exactly the impossible state the claim exists to prevent:
> the customer charged, the order cancelled, and the row reading `VOIDED` with nothing in
> the system aware there was anything to reconcile. So the cancel loses the race cleanly
> and the caller retries once the capture settles.
>
> Two further hardenings landed alongside it. The pre-transaction fulfillment-presence
> check above is now a **fast fail** only; the guard that holds under contention is an
> in-transaction re-read of every fulfillment under `findByIdForUpdate` (a pessimistic
> `SELECT … FOR UPDATE`), which serialises against a concurrent Ship of the same order.
> And the payment is re-loaded with `findByOrderIdForUpdate`, **not** a snapshot read —
> a REPEATABLE READ snapshot would not observe a claim taken by a racing capture.

### The payment-outcome split — `void` vs `flagged_for_refund`

How the payment is settled depends on whether money has already changed hands:

- **`authorized` → `void`.** The funds were only *held*, never taken, so cancelling
  releases the authorization. `Payment.void()` walks the row `authorized → voided`. The
  in-process fake gateway has no `void` call (it never reserved real funds); a real
  gateway would void the held authorization here — out of scope for this capability, but
  the domain transition is the seam for it.
- **`captured` → `flagForRefund`.** The money is already taken, so cancellation cannot
  simply undo it. `Payment.flagForRefund()` sets `flagged_for_refund = true` and leaves
  the row `captured`; the refund capability consumes the flag and issues the actual
  refund (a *later* capability when this shipped — it has since landed, see §2).

A payment in any other state (already voided/refunded/failed, or absent) is left as-is.

#### Why the order's payment *axis* stays put

`Payment` is a separate row with its own `PaymentStatusEnum` (`authorized` / `captured` /
`voided` / `refunded` / `failed`). The **order header** carries an orthogonal payment
*axis*, `OrderPaymentStatusEnum`, which is a *different* value set — it has a `none` member
(for the pre-payment window) but **no `voided` member**. This is deliberate (ADR-028 §2):
the three order axes (lifecycle, payment, fulfillment) evolve independently and each
encodes only what the order header needs. Voiding a payment is a fact about the `payment`
*row*, not a new order-header payment state — so Cancel Order moves only the lifecycle axis
(`→ cancelled`) and the `payment` row's status; the order's payment axis keeps its value.
Trying to mirror `voided` onto the order axis would force a value the axis was designed not
to carry.

### Allocation release via the existing `inventory.allocation.cancel`

After the local transaction commits, Cancel Order releases the order's stock allocation by
calling the existing `ORDER_INVENTORY_GATEWAY.cancelAllocation(...)`
(`inventory.allocation.cancel`, ADR-030 §4) — per line it returns the allocated units to
`available` (`StockLevel.releaseAllocated`) and appends one negative `release`
`StockMovement` (`reason_code = 'order-cancelled'`, `referenceType = 'order'`). Because the
precondition guarantees nothing shipped, the place-time allocation is intact for every
line at its full ordered quantity, so the release covers the whole order.

The release runs **after** the local commit (its own RPC into inventory's own
transaction), with the same posture Ship's Commit Sale uses: a bounded retry, then — on
persistent failure — a single `error` log of the full payload for operator replay,
**without throwing**. The local cancel is durable and is **never** rolled back on an
inventory hiccup (eventual consistency on the release). A failed release over-holds the
stock (the units stay counted in `quantity_allocated`) until a manual intervention frees
them — it never corrupts the counters.

### Authorization — owner-or-staff

A customer may cancel **its own** pending order; staff with `order:cancel` may cancel any
(ADR-024 / ADR-028 §7). This is enforced by `loadAuthorizedOrder(..., isStaffCancel)`:
allow if the staff override is set **or** `order.customerId === actorId`, else
`ORDER_ACCESS_FORBIDDEN` (403); a missing order is 404. The permission code is a *staff
override* over the owner-check, never a customer gate — customer tokens carry no
permissions claim.

### Post-commit event

Cancel Order emits `retail.order.cancelled` (a key ADR-028 *retired* with the old order
model, **re-introduced fresh** here with this live producer) best-effort. It carries
`paymentFlaggedForRefund` so a downstream consumer can distinguish a captured-and-flagged
cancellation (a refund is owed) from a simple voided-authorization one, plus the optional
human `reason`.

> **It was a reserved surface with no consumer when this shipped; it now has two, and is
> the only order event emitted onto two queues.** `OrderRabbitmqPublisher` emits it onto
> the producer's own `retail_queue` — where retail's **own** `OrderCancelledConsumer` reads
> it and, when `paymentFlaggedForRefund` is set, issues the refund inline through
> `IssueRefundUseCase` ([ADR-032](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md))
> — **and** onto `notification_events`, where the notification service's
> `OrderCancelledNotificationConsumer` renders the cancellation email
> ([ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md)). It is
> mirrored onto `ris.events` **once**: one logical event, two queue destinations
> (ADR-035). That auto-refund consumer is what turns §2's flag from a claim into money
> actually moving — see the correction there.

## 2. The `flagged_for_refund` flag

The `payment.flagged_for_refund` column (a `TINYINT(1)` defaulting `0`) ships ahead of its
consumer — the column and the read-only `Payment.flaggedForRefund` getter were added with
the order-RBAC groundwork, before any writer existed (the "column ships ahead of its
writer" precedent, ADR-028 §6). **Cancel Order is its first and only writer**: it sets the
flag (via `Payment.flagForRefund()`, an idempotent no-op if already set) exactly when it
cancels an order whose payment was already **captured**.

The flag means "this captured payment owes a refund". This capability does **not** issue
the refund — there is no money movement here; a later refund capability reads the flag,
calls the gateway to refund, and walks the payment `captured → refunded`. Keeping the flag
orthogonal to `status` (a flagged payment stays `captured`) is what lets the refund
capability find exactly the payments that need attention without re-deriving the
cancellation history.

> **That later capability has landed**
> ([ADR-032](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)): a `Refund`
> aggregate sibling to `Payment`, `IssueRefundUseCase`, and the
> `retail.refund.issue` / `.list` RPCs behind `POST /api/orders/:orderId/refunds`. The
> flag's consumer is retail's own `OrderCancelledConsumer`, which reads
> `retail.order.cancelled` off `retail_queue` and auto-issues a **full** refund inline when
> `paymentFlaggedForRefund` is set (§1). Its idempotency needs no job table: once the
> capture is fully refunded, `refundedAmountMinor === amountMinor`, so a redelivery
> computes a refundable of `0` and no-ops before any gateway call. The consumer is
> best-effort and never throws — a failed auto-refund leaves the payment
> `flagged_for_refund`, which is exactly the flag's purpose: a redelivery or a manual
> `POST /refunds` can still settle the money. So Cancel Order still moves no money
> *itself*; it now reliably triggers something that does.

## 3. Cancel Line

`CancelLineUseCase` cancels the **unshipped quantity of a single `OrderLine`** — a narrower
unwind than Cancel Order, for when one line of a multi-line order can no longer be
fulfilled while the rest stands.

### Unshipped quantity only

The cancellable quantity is `activeQuantity − alreadyFulfilled`, where `alreadyFulfilled`
is the sum of that line's quantity across the order's **non-`cancelled`** fulfillments (the
same remainder Create measures — a `pending` shipment counts as committed, a `cancelled` one
frees its slice back). An omitted `quantity` cancels all of it; a `quantity` over the
remainder is rejected `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING` (409, the code reused from
Create). An unknown line is `ORDER_LINE_NOT_FOUND` (404).

> **This shipped as `ordered − alreadyFulfilled`, and that was a hole**, closed by
> [ADR-040](../../adr/040-persisted-cancelled-quantity-on-order-line.md). Nothing recorded
> the cancellation, so the remainder was recomputed from the place-time `ordered` on every
> call and **the same units stayed cancellable forever** — each pass releasing their
> allocation again and driving the *shared* per-`(variant, location)` `quantity_allocated`
> below the truth, which eats other orders' allocations. Three more defects followed from
> the same omission: Cancel Line then Cancel Order released the same units twice (Cancel
> Order built its payload from `ordered`); cancelled units stayed shippable (Create measured
> the same stale remainder); and cancelled units stayed returnable.
>
> The fix is a durable count: `order_line.cancelled_quantity` (`INT NOT NULL DEFAULT 0`,
> migration `1783693307152`, `CHECK 0 ≤ cancelled_quantity ≤ quantity`), and
> **`activeQuantity = quantity − cancelledQuantity`** as the bound *every* downstream rule
> now measures — this remainder, Cancel Order's release payload, Create's shippable
> remainder, Ship's per-line "fully shipped" test, and the returns pool. Cancelling a line's
> **last** active unit moves it to the terminal `cancelled` status — the first writer of
> that enum member. The money columns are untouched: `line_total_minor` stays the buyer's
> place-time snapshot, because cancelling units changes what the order *owes*, not what it
> *cost*.

Authorization is **staff-only** (`order:cancel` via `isStaffCancel`): a line-level cancel
is an operator action, not an owner operation (unlike Cancel Order, which a customer may
run on its own pending order). A non-staff caller is `ORDER_ACCESS_FORBIDDEN` (403).

### Proportional allocation release; no money mutation

Cancel Line releases just the cancelled quantity's allocation — a single-line
`inventory.allocation.cancel` for `{ variantId, stockLocationId, quantity }`
(`reason_code = 'line-cancelled'`), with the same best-effort retry-then-log posture as
Cancel Order. The order's other lines and the already-fulfilled quantity of this line are
untouched.

It makes **no money-total change**. The order's `subtotalMinor` / `grandTotalMinor` and
the line's snapshot money fields stay exactly as placed — issuing a credit or refund for
the cancelled quantity belongs to the refund capability, not here. This operation emits
**no event**, so nothing downstream can react to it — note the asymmetry with Cancel
*Order*, which flags the payment and lets `OrderCancelledConsumer` auto-refund it:
cancelling a *line* moves no money and triggers nothing that will. Refunding those units
is a separate, deliberate `POST /api/orders/:orderId/refunds` call.

> **"The order itself is not otherwise mutated" is no longer true**, and its consequence —
> "the shippable remainder simply shrinks logically" — was the bug ADR-040 fixed. Cancel
> Line is now a **writing** operation:
>
> - it persists `order_line.cancelled_quantity` through the aggregate root
    > (`Order.cancelLineQuantity(orderLineId, units)` → `OrderLine.cancelQuantity`), so the
    > remainder shrinks *durably*, not logically;
> - the write takes the same **version-checked compare-and-swap** every other order mutator
    > takes (`runWithOrderWriteRetry`, `OCC_RETRY_ATTEMPTS`, exhaustion → `409
>   VERSION_MISMATCH`). This **reverses ADR-031's "no optimistic-concurrency guard" for this
    > operation only** — that reasoning was sound for a *stateless* Cancel Line and is void
    > now. Without the CAS two concurrent cancels could each read `cancelled_quantity = 0`,
    > both commit their own `+1`, lose one update, and reinstate the over-release the column
    > exists to prevent;
> - and the **local write commits before the allocation release** (the Cancel Order
    > posture). Releasing first would reinstate the bug on any rollback — a released slice with
    > no committed count is exactly the pre-fix state. A failed release now over-holds stock
    > until manual intervention (safe and visible) instead of over-releasing it.
>
> Cancel Line remains **eventless**, which is the one part of the original sentence that
> still stands.

## 4. Mark Delivered

`MarkDeliveredUseCase` is the happy-path terminal. A carrier (or, since carrier webhooks
are out of scope, an operator) confirms a `shipped` fulfillment arrived. It is the simplest
of the three operations: it crosses no service boundary (the stock already shipped at Ship
time via Commit Sale) and touches no payment (capture already happened at Ship).

It advances the per-shipment `Fulfillment → delivered` (`Fulfillment.markDelivered(at)`,
which guards `shipped → delivered`). Then, in the **same** local transaction, it rolls the
order up: **only when every non-`cancelled` fulfillment of the order is now delivered** does
it call `Order.markDelivered()`, which advances **both** the lifecycle axis and the
fulfillment axis to `delivered` (the one place delivery touches the lifecycle axis). A still
-`pending` or still-`shipped` sibling leaves the order as-is — the last delivery is what
closes the order out.

`Order.markDelivered()` requires the order to be `shipped`-reachable — the fulfillment axis
must be `partially-shipped` or `shipped` and the lifecycle must not be `cancelled` — else
`ORDER_INVALID_FULFILLMENT_TRANSITION` (409). Authorization is owner-or-staff
`order:fulfill` (the same shape as Create/Ship), and the operation returns the delivered
`FulfillmentView` (the order's advanced statuses are observable via a follow-up
`retail.order.get`); it emits `retail.fulfillment.delivered` best-effort.

> **The queue and the "reserved" label are both out of date.** `retail.fulfillment.shipped`
> and `.delivered` are emitted onto **`notification_events`**, not `retail_queue` — the
> producer targets the *consumer's* queue (ADR-008/020) — and their consumer exists: the
> notification service's `FulfillmentEventsConsumer` renders the shipment- and
> delivery-confirmation emails
> ([ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md)). That
> is also why both Ship and Deliver resolve the buyer's email through
> `ORDER_CUSTOMER_CONTACT_READER` and put it on the event: the consumer needs a recipient
> without a per-delivery RPC back into the gateway. The resolution is best-effort — a
> tombstoned or missing customer yields `null` and the helper never throws.

Because there is no carrier-webhook integration, Mark Delivered is exposed (by the gateway
HTTP front, `POST /api/orders/:orderId/fulfillments/:fulfillmentId/deliver`) as an admin
endpoint an operator drives manually.

## Cross-links

- [ADR-031 — Fulfillment aggregate and ship-triggered capture](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md) —
  the whole fulfillment-and-ship capability, including the Cancel Order/Line payment-settle
  and allocation-release decisions and the Deliver roll-up.
- [ADR-030 — Reservation TTL aggregate and the stock-movement ledger](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) —
  the `inventory.allocation.cancel` allocation-release seam (the negative `release`
  movement) these operations reuse.
- [ADR-028 — Cart, Order, Payment, and Address — the rebuilt checkout chain](../../adr/028-cart-order-payment-and-address-chain.md) —
  the three orthogonal order status axes, the owner-or-staff authorization model, and the
  `flagged_for_refund` column shipped ahead of its writer.
