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

All three live in the retail `orders/` module and are reached over RabbitMQ today; their
gateway HTTP front (the admin-facing endpoints) lands with a later capability.

| Operation | Routing key | Use case | Returns |
| --- | --- | --- | --- |
| Mark Delivered | `retail.fulfillment.deliver` | `MarkDeliveredUseCase` | `FulfillmentView` |
| Cancel Order | `retail.order.cancel` | `CancelOrderUseCase` | `OrderView` |
| Cancel Line | `retail.order.cancel-line` | `CancelLineUseCase` | `OrderView` |

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

The single hard precondition is: **the order must have no `shipped` or `delivered`
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

### The payment-outcome split — `void` vs `flagged_for_refund`

How the payment is settled depends on whether money has already changed hands:

- **`authorized` → `void`.** The funds were only *held*, never taken, so cancelling
  releases the authorization. `Payment.void()` walks the row `authorized → voided`. The
  in-process fake gateway has no `void` call (it never reserved real funds); a real
  gateway would void the held authorization here — out of scope for this capability, but
  the domain transition is the seam for it.
- **`captured` → `flagForRefund`.** The money is already taken, so cancellation cannot
  simply undo it. `Payment.flagForRefund()` sets `flagged_for_refund = true` and leaves
  the row `captured`; a later refund capability consumes the flag and issues the actual
  refund (see §2).

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
model, **re-introduced fresh** here with this live producer) best-effort onto the
producer's own `retail_queue` — a reserved surface today (no consumer yet). It carries
`paymentFlaggedForRefund` so a downstream consumer can distinguish a captured-and-flagged
cancellation (a refund is owed) from a simple voided-authorization one, plus the optional
human `reason`.

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

## 3. Cancel Line

`CancelLineUseCase` cancels the **unshipped quantity of a single `OrderLine`** — a narrower
unwind than Cancel Order, for when one line of a multi-line order can no longer be
fulfilled while the rest stands.

### Unshipped quantity only

The cancellable quantity is `ordered − alreadyFulfilled`, where `alreadyFulfilled` is the
sum of that line's quantity across the order's **non-`cancelled`** fulfillments (the same
remainder Create measures — a `pending` shipment counts as committed, a `cancelled` one
frees its slice back). An omitted `quantity` cancels all of it; a `quantity` over the
remainder is rejected `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING` (409, the code reused from
Create). An unknown line is `ORDER_LINE_NOT_FOUND` (404).

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
the cancelled quantity belongs to the later refund capability, not here. The order itself
is not otherwise mutated (there is no `cancelled` arm on the per-line status that this
capability transitions to; the shippable remainder simply shrinks logically because the
released allocation no longer backs the cancelled units), and this operation emits **no
event** — the scope is intentionally minimal: release the allocation, return the order
view.

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
`retail.order.get`); it emits `retail.fulfillment.delivered` best-effort onto `retail_queue`
(a reserved surface today).

Because there is no carrier-webhook integration, Mark Delivered is exposed (by the later
gateway HTTP front) as an admin endpoint an operator drives manually.

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
