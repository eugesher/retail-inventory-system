# Optimistic concurrency on the operational aggregates: Cart, Order, Fulfillment, ReturnRequest, and the `If-Match` + `409 VERSION_MISMATCH` contract

Inventory already resolves concurrent writes to a single row with a version-checked
compare-and-swap wrapped in a bounded retry (see
[`03-occ-on-stocklevel-reservation.md`](03-occ-on-stocklevel-reservation.md)). The
operational aggregates — `Cart`, `Order`, `Fulfillment`, `ReturnRequest` — all **ship a
`version` column** but historically did not consume it, so two concurrent writers to one
aggregate (two browser tabs editing one cart, a ship racing a cancel, two staff editing one
order) could silently lose an update.

This document describes turning that shipped-but-unenforced column into a real optimistic-
concurrency (OCC) layer across **all four** operational aggregates, plus the **client
contract** they share: the optional `If-Match` precondition and the uniform
`409 VERSION_MISMATCH` wire code. It opens with the **cart write path** (the reference
protocol) and the shared contract, then covers the **order status transitions**, the
**fulfillment** reconciliation with its pre-existing pessimistic lock, and the
**return-request** six-state lifecycle — closing with the **two-legitimate-409s** model that
ties them together.

Related decisions: [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) (the
enforced OCC, the configurable retry budget, the `409 VERSION_MISMATCH` translation, and the
`If-Match` convention), [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) (the
mutable `Cart` aggregate, the immutable `Order`'s three status axes + its `version` column,
and the `throwRpcError` typed-code forwarding),
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) (the bounded
optimistic write protocol this generalizes),
[ADR-031](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md) (the `Fulfillment`
aggregate and the targeted ship-vs-cancel `SELECT … FOR UPDATE` row lock), and
[ADR-032](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md) (the `ReturnRequest`
RMA lifecycle and its `version` column).

## The correctness rule

A cart is a mutable working set of lines with a running subtotal. Two writers that both read
the same cart, both decide their edit is valid, and both write back would lose one update —
one shopper's "add line" or "change quantity" vanishes. Worse, the cart also drives
inventory: an add/change **reserves** the line's absolute target quantity before saving, so a
lost update can leave a hold that no longer matches the persisted cart. OCC closes both holes
by making concurrent writers serialize through the cart root's `version`, with exactly one
winner per version.

## The OCC contract (read-version → mutate → version-checked persist)

Each cart mutator (`AddToCartUseCase`, `ChangeCartLineQuantityUseCase`,
`RemoveFromCartUseCase`) follows the same protocol, mirroring the inventory write protocol:

1. **Load** the cart, capturing its `version` **before** any mutation.
2. **Reserve/release** the affected inventory (add/change reserve the absolute target;
   remove releases after the save). The reserve RPC is idempotent-by-absolute-quantity, so it
   is safe to re-run.
3. **Mutate** the aggregate in memory (`addLine` / `changeLineQuantity` / `removeLine`), which
   enforces the domain invariants (unknown line → `CART_LINE_NOT_FOUND`, a non-active cart →
   `CART_NOT_ACTIVE`, and so on).
4. **Persist with a compare-and-swap on the cart root:**
   `UPDATE cart SET …, version = version + 1 WHERE id = :id AND version = :expectedVersion`.
   The root `version` is the OCC anchor for the **whole aggregate** — even a pure line edit
   (which changes no root column) bumps it, so two concurrent line writes serialize through
   this one `UPDATE`. Zero rows affected means a concurrent writer already advanced the
   version — a lost race, surfaced as an internal `CartWriteConflictError`.
5. **On a lost race:** re-read the now-current cart and retry the whole step from a fresh read
   (re-loading also **re-computes the absolute reserve target**, which depends on the current
   line quantity), up to `OCC_RETRY_ATTEMPTS` attempts. On exhaustion the write surfaces a
   `409 VERSION_MISMATCH` carrying the row's current version.

The whole read-reserve-mutate-persist sequence runs inside a shared bounded-retry helper,
`runWithCartWriteRetry`, the cart-side analogue of inventory's `runWithStockWriteRetry`. A
domain rejection (a bad line id, a stale `If-Match`, an out-of-stock reserve) propagates
immediately and is **never** retried; only a `CartWriteConflictError` triggers a retry.

Because the CAS and its unit of work live inside `CartTypeormRepository.save(cart,
expectedVersion)`, the cart helper needs no transaction port — an attempt is a plain
`async () => …` the helper re-invokes. The repository translates a zero-rows CAS into the
conflict signal, re-reading the committed current version on a fresh query (not the rolled-
back transaction's snapshot) so the signal carries the accurate version the caller should
refetch.

### The configurable retry budget

The attempt count is `OCC_RETRY_ATTEMPTS` (Joi-validated `integer().min(1)`, default **5**),
resolved from the environment through a `ConfigService`-backed value-provider token and
injected into each use case as a plain `number` — never read from `process.env` inside the
application layer ([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)). It is
the same knob inventory uses; the default of 5 keeps the high-contention concurrency tests
converging (see [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md)).

### Auditability

A lost race that is retried logs at `info` (the correlation id, the cart id, the attempt
number, the budget, and the current version the winner left behind). Exhaustion logs at
`warn` before raising the `409`. This mirrors the inventory protocol's trace so the
concurrency behavior is observable under contention.

## The `If-Match` convention

A client that holds a known cart version may pin it. The three cart line routes accept an
**optional** `If-Match: <version>` header carrying the `version` the client last read
(surfaced on `CartView.version`):

```
PATCH /api/cart/{cartId}/lines/{lineId}
If-Match: 4
```

- **Header shape.** A bare non-negative integer version. A surrounding pair of double quotes
  (ETag style, `If-Match: "4"`) is tolerated. A present-but-malformed value (non-integer /
  negative) fails fast at the gateway edge with `400 { code: 'IF_MATCH_INVALID' }` — a
  precondition is never silently ignored, because ignoring it would let the write proceed
  unguarded.
- **Precondition-failed semantics.** When the header is present and the loaded cart's version
  differs, the client's view is already stale, so the write is rejected **immediately** with
  `409 VERSION_MISMATCH` (carrying `details.currentVersion`) and is **not** retried. Retrying
  would defeat the precondition: the client explicitly asked to enforce "only if the cart is
  still at version N", so a last-writer-wins retry loop must not override it. Concretely, an
  `If-Match` write runs with a retry budget of exactly **one** attempt — both the stale-at-
  load case and a lost CAS between load and write resolve to the same immediate `409`.
- **When it is absent.** No precondition is enforced; the bounded retry makes the last writer
  within the budget win. This is the convenient default for a single-tab shopper who does not
  care about detecting a concurrent edit.

The precondition is threaded from the edge to the domain with a reusable `@IfMatch()`
parameter decorator (the gateway's `common/decorators/`), which parses the header into an
`expectedVersion: number | undefined` folded onto the command. The retail use case honors it
via `assertCartVersion(cart, expectedVersion)`.

## The uniform `409 VERSION_MISMATCH` (two layers)

A client should branch on **one** stable code regardless of which aggregate or service lost
the race. The cross-service wire code is `VERSION_MISMATCH` (not a cart-specific
`CART_VERSION_*`), and the current version rides along in `details.currentVersion` so the
client can refetch-and-retry. Two layers emit it:

### Layer 1 — the microservice RPC filter (cross-service writes)

The cart context owns a `CartErrorCodeEnum.CART_VERSION_MISMATCH` whose **member name** keeps
the module's `CART_` prefix but whose **wire value** is the uniform `VERSION_MISMATCH`. The
`CartRpcExceptionFilter` maps it to HTTP `409` and forwards the exception's structured
`details` (`{ currentVersion }`) — exactly how inventory forwards `{ available }` on an
out-of-stock rejection ([ADR-030 §6](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)).
Inventory keeps its own `STOCK_WRITE_CONFLICT` code (also a `409`); `VERSION_MISMATCH` is the
operational-aggregate name for the same class of optimistic conflict.

The gateway's `throwRpcError` already forwards any `409` (indeed any 4xx/5xx that carries a
typed `code`) together with its `code` and object-valued `details` verbatim
([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)), so the client receives:

```json
{ "statusCode": 409, "message": "…", "code": "VERSION_MISMATCH", "details": { "currentVersion": 5 } }
```

### Layer 2 — the gateway-global filter (gateway-local OCC)

A gateway-global exception filter, `OptimisticLockExceptionFilter`, maps TypeORM's
`OptimisticLockVersionMismatchError` to the same `409 { code: 'VERSION_MISMATCH',
currentVersion }`. It is registered as an `APP_FILTER` provider (beside the existing
duplicate-key filter). The gateway's own TypeORM writes (the `auth` aggregates) carry no
version columns today, so in practice this is **defense-in-depth + the normalized contract +
the documented convention** — but it makes the gateway honor `VERSION_MISMATCH` uniformly the
moment any gateway-local aggregate adopts optimistic locking, so a lost gateway-side CAS never
leaks a raw `500`. TypeORM bakes the versions into the error message rather than exposing them
as fields, so the filter recovers the current version by parsing the message and omits
`currentVersion` when it cannot.

## What this does and does not change

- **Cart add / change / remove are version-checked.** Two concurrent edits to one cart resolve
  to exactly one winner; the loser either retries (no `If-Match`) or gets a `409` (a stale
  `If-Match`, or the budget exhausted).
- **The create path is unchanged.** A brand-new cart has no live row to race, so
  `CartTypeormRepository.save` without an `expectedVersion` falls back to a plain insert.
- **Cart claim** (`reassignCustomer`) remains a direct column update — a guest-promotion is not
  a contended edit path.
- **The reserve/release inventory calls stay in place**; the only change is that add/change
  re-run the reserve on a retry (idempotent by absolute quantity) so a re-read never
  under-reserves.

## Order status transitions

`Order` is the immutable checkout root carrying **three orthogonal status axes** (lifecycle /
payment / fulfillment) plus a `version` column ([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)).
Its status mutators — `markPaymentCaptured`, `advanceFulfillment`, `cancel`, `markDelivered`
— each bump the version. The operations that call them can genuinely race: two staff shipping
two different fulfillments of one order both advance the order's fulfillment roll-up; a
Capture can race a Ship; a Cancel can race a Ship. Without a guard, one roll-up silently
overwrites the other.

Every order-state-writing use case now wraps its transaction in the shared bounded-retry
helper `runWithOrderWriteRetry` (the order-side analogue of `runWithCartWriteRetry` /
`runWithStockWriteRetry`) and persists the root through a **version-checked CAS**:

- **`CapturePaymentUseCase`** — advances the payment axis (`markPaymentCaptured`).
- **`ShipFulfillmentUseCase`** — advances the fulfillment axis + the payment axis (on a
  ship-triggered capture).
- **`MarkDeliveredUseCase`** — rolls the order up to `delivered` once the last fulfillment
  delivers.
- **`CancelOrderUseCase`** — cancels the lifecycle axis + settles the payment.

The protocol per attempt: open a fresh transaction, **re-read** the order inside it (capturing
`version`), mutate, then `OrderTypeormRepository.save(order, scope, expectedVersion)` runs
`UPDATE order SET …, version = version + 1 WHERE id = :id AND version = :expectedVersion`.
Zero rows affected → an internal `OrderWriteConflictError` → the transaction rolls back and the
helper retries the **whole unit of work** from a fresh read, up to `OCC_RETRY_ATTEMPTS`. On
exhaustion the write surfaces `409 VERSION_MISMATCH` (member `ORDER_VERSION_MISMATCH`, wire
value `VERSION_MISMATCH`) carrying `details.currentVersion`.

Two ordering rules are preserved unchanged around the retried transaction:

- **Ship's capture + commit-sale ordering ([ADR-031](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)).**
  The out-of-process gateway `capture` runs **once, before** the retry loop — a retry never
  re-charges. The post-commit `inventory.stock.commit-sale` (idempotent on `fulfillmentId`)
  runs **after** the loop's winning commit. OCC wraps only the local order/fulfillment/payment
  commit in between.
- **Fresh-read-per-attempt for the mutated objects.** Everything a transaction mutates — the
  order, the fulfillment, and the payment — is (re-)loaded **inside** the callback (the
  payment repository's `findByOrderId` is scope-aware for exactly this), so a retried attempt
  starts from pristine, committed state and every domain mutator (`capture`, `markPaymentCaptured`,
  `ship`) sees a valid pre-state. This is why the CAS conflict is retryable rather than
  poisoning the in-memory graph.

**Two order paths deliberately keep the plain managed save (no CAS):**

- **Place Order.** The order is *created* (an insert — no live row to race), and the concurrent
  double-place guard is the **cart-conversion compare-and-swap** (`markConverted`'s
  `UPDATE cart … WHERE status = 'active'`, which also bumps the cart version): a losing racer
  matches zero rows, throws, and rolls the place back, so exactly one order is ever minted from
  a cart. The inline `AuthorizePaymentUseCase` write that follows runs on that brand-new order
  before any second actor can reach it, so it too takes the plain managed save (the version
  still advances via `@VersionColumn`).
- **Cancel Line.** It performs **no** order-state write at all — it reads the order to validate
  the unshipped remainder and releases the inventory allocation via a cross-service RPC. With no
  local aggregate write there is no lost update to guard against, so it takes no CAS; the
  remainder is recomputed from the live `fulfillment` rows on every call.

## Fulfillment: pessimistic lock kept, with the version still participating

The `Fulfillment` aggregate already had the strongest guard on the checkout write surface: Ship,
Cancel, and Deliver re-read the contended fulfillment row with a **`SELECT … FOR UPDATE`**
(`findByIdForUpdate`) **inside** their transaction ([ADR-031](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)).
That pessimistic row lock serialises any two transitions of the **same** fulfillment: the second
writer blocks until the first commits, then observes the committed status, at which point its
status precondition rejects it. This is the single-writer-per-transition guard the
`concurrent-ship-cancel` suite locks.

The OCC layer **keeps that lock as the sole serialization strategy on the fulfillment row** and
does **not** add a competing version-checked CAS to the fulfillment `save` — layering two lock
strategies on one path would be redundant and confusing. The fulfillment `version` still advances
on each transition (TypeORM's `@VersionColumn` increments it on the managed save), so the column
stays meaningful for reads and future use; it simply is not the *guard* for the fulfillment row
(the lock is).

Where the fulfillment operations DO participate in OCC is the **order header** they roll up: Ship
and Deliver advance the order's fulfillment axis, and that order write is the version-checked CAS
described above. So:

- Two Ships of **different** fulfillments of one order don't contend on any single fulfillment
  lock — they race the **order version**. The CAS makes one win and the other retry (re-reading
  the now-advanced roll-up and recomputing its own); a genuinely stuck race exhausts the budget
  and surfaces `409 VERSION_MISMATCH`.
- A Ship and a Cancel of the **same** fulfillment serialise on the **fulfillment row lock**. The
  loser observes the committed status and gets its precise **domain** `409`
  (`FULFILLMENT_INVALID_STATUS_TRANSITION` if it tried to ship a now-cancelled fulfillment, or
  `ORDER_NOT_CANCELLABLE` if it tried to cancel an order that now has a shipped fulfillment) —
  **never** retried, because a state the request genuinely forbids is terminal.

## ReturnRequest: version-checked six-state transitions

`ReturnRequest` walks the RMA lifecycle `requested → authorized → received → inspected → closed`
(+ `→ rejected`), carrying a `version` column ([ADR-032](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)).
Two staff acting on one RMA at once (e.g. two `authorize` clicks, or an `inspect` racing a
`reject`) could lose an update. Each transition use case (`AuthorizeReturnUseCase`,
`RejectReturnUseCase`, `ReceiveReturnUseCase`, `InspectAndDispositionUseCase`,
`CloseReturnUseCase`) now wraps its write in `runWithReturnWriteRetry` and persists the root via
the version-checked CAS in `ReturnRequestTypeormRepository.save(returnRequest, scope,
expectedVersion)`.

The five simple transitions (`authorize` / `reject` / `receive` / `close`) have no transaction
of their own — the CAS lives inside `save`, so an attempt is `load → capture version → mutate →
save(…, expectedVersion)`; a lost race re-reads and retries. `InspectAndDisposition` runs inside
a `TRANSACTION_PORT` scope (it records per-line inspection outcomes and walks the status in one
unit of work, then restocks after commit — [ADR-032](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)),
so its retry **re-loads the RMA fresh inside each attempt** — the `ReturnLine.inspect` mutation
is inspect-once, so a retry must start from an un-inspected re-read. Exhaustion surfaces
`409 VERSION_MISMATCH` (member `RETURN_VERSION_MISMATCH`, wire value `VERSION_MISMATCH`) with
`details.currentVersion`; the after-commit restock ordering is unchanged.

Both the orders and returns RPC exception filters map their OCC code to `409` and forward the
exception's `details` verbatim, exactly as the cart filter does — the filter `Record`s stay
*total* (exhaustive over the enum), so a new code fails the build until it is mapped.

## The two legitimate 409s: `VERSION_MISMATCH` vs the domain invalid-transition codes

A concurrent transition always resolves to **exactly one winner and one loser**, and the loser
always gets a `409`. But there are **two legitimate, intentional sources** of that `409`, and the
distinction is deliberate — not an accident of which guard happened to fire:

| The loser hit… | Guard | Code | Retried? | Meaning |
| --- | --- | --- | --- | --- |
| A **same-transition** optimistic CAS loss | version CAS + bounded retry | `VERSION_MISMATCH` (`details.currentVersion`) | yes, up to the budget, then `409` | "The row's version moved under you; refetch and retry." |
| A **cross-transition** state that is genuinely illegal after serialization | pessimistic `SELECT … FOR UPDATE` (fulfillment) or the domain state guard | the module's domain code (`ORDER_NOT_CANCELLABLE`, `FULFILLMENT_INVALID_STATUS_TRANSITION`, `RETURN_INVALID_STATUS_TRANSITION`) | **no** — terminal | "After the winner committed, your transition is no longer legal at all." |

Both mean *"you lost the race"*, and both are `409`s — so a client can treat any `409` on a write
as "refetch and reconsider". The difference is whether a retry could *ever* succeed: a
`VERSION_MISMATCH` might (the row simply moved), so the protocol retries it within the budget; a
domain invalid-transition never will (the order is now shipped, the fulfillment now cancelled,
the RMA now closed), so it is surfaced immediately. Retrying a terminal domain rejection would be
a bug — it would spin the budget pointlessly and could mask a real state error — so the retry
helpers catch **only** the internal `*WriteConflictError` signal and let every domain exception
propagate on the first attempt.
