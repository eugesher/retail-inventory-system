# 06 — Returns & Refunds extension guides

The six Returns & Refunds guides under [`docs/extensions/`](../../extensions/) sketch how a business would
grow the RMA and refund model past the universal core. This cluster's whole difficulty is **drawing
lines**: three of its guides circle one question — how a shop sends the customer a *different* thing — and
they are only worth writing if they are distinguishable from their first paragraph. The other three attach
to seams the core already has (a line disposition, the `Refund` aggregate, an external scoring port) and
their discipline is inheriting an owner's decision rather than re-modelling it.

Every path, enum member, port symbol and routing key named below was read out of the source this
session, because the point-in-time notes in this folder describe a capability at ship time, not
necessarily its shape today. Two structural facts of the code shape almost every sketch here, and both
were confirmed against source:

1. **`returns/` may not import `orders/`** — a lint-enforced isolation line (ADR-017). The returns module
   reads order data through `RETURN_ORDER_READER`, a raw-SQL reader returning a flat `IReturnOrderSnapshot`
   (`orderId`, `customerId`, `status`, `fulfillmentStatus`, `shippedAt`, `deliveredAt`, and per-line
   `orderLineId` / `variantId` / `quantity` / `cancelledQuantity`). Any extension that needs *more* than
   that grows the reader; it does not reach across.
2. **`Refund` lives in `orders/`, not `returns/`** (ADR-032) — because every refund operation mutates
   `Payment`, and `Payment` is an orders-module aggregate. A return that closes with money owed *triggers*
   a refund; it does not own one. So a refund extension attaches on the orders side.

## The privacy and stock rails, verified against the code

- **No PII on the bus.** The restock seam's payload (`IRestockFromReturnPayload`) already carries
  `returnRequestId` + `lines[]` + optional `actorId` — **ids only**. Every new event these sketches propose
  keeps that shape. The likeliest place to break it is return-fraud-scoring, which is *about* a person's
  behaviour; that guide states the id-only rail up front and keeps the score request and its events free of
  name/email/address (ADR-037 §4).
- **Restock is a ledger movement through a port.** `INVENTORY_RESTOCK_GATEWAY.restockFromReturn(...)` runs
  *after* the local inspection commit and is **idempotent on `returnRequestId`**. Every sketch that moves
  stock — repair's deferred restock, vendor RMAs' outbound decrement — lands as an append-only movement
  through an inventory gateway port, never a direct stock write.
- **The return window is configuration.** `RETURN_WINDOW_DAYS` is a DI token (Joi default 30), injected as
  a plain `number`; advance-replacement's deadline should arrive the same way, never as a literal.

## The six guides

### [exchanges-as-first-class-entity.md](../../extensions/returns-and-refunds/exchanges-as-first-class-entity.md)

- **Claim.** One aggregate spanning an inbound return and an outbound `Order`, so a swap cannot be closed
  half-done. **Owns the three-way split** (below).
- **Attaches to.** `return-request.model.ts` (the inbound RMA it references by id) and
  `return-line.model.ts` (the inbound-to-outbound line mapping).
- **Hardest to reverse.** Where the `Exchange` lives, given `returns/` ↛ `orders/` and the outbound is an
  `Order`: a thin coordinator referencing both sides by id, or a returns-owned entity reaching the order
  through a grown reader.

### [repair-workflows.md](../../extensions/returns-and-refunds/repair-workflows.md)

- **Claim.** A `repair` disposition that is **non-terminal** — the one disposition that leaves and comes
  back, deferring a line's final destination (restock-refurbished / return-to-customer) until the repair
  closes.
- **Attaches to.** `return-line.model.ts` (the write-once `disposition` a repair must make provisional) and
  the restock gateway port (a *deferred* restock, same idempotent seam, later timing).
- **Hardest to reverse.** A new disposition value vs. a `repairStatus` orthogonal to disposition — the
  former overloads a field the code treats as a final, single-write decision.

### [advance-replacement.md](../../extensions/returns-and-refunds/advance-replacement.md)

- **Claim.** Ship the substitute *before* the return arrives — an exchange whose outbound leg fires first.
  A credit-risk and stock-commitment problem, **not** a new modelling of the swap.
- **Attaches to.** `return-request.model.ts` (the inverted timeline) and
  [`order.model.ts`](../../../apps/retail-microservice/src/modules/orders/domain/order.model.ts) (the
  outbound order, reached cross-module, never imported).
- **Hardest to reverse.** How much trust and gated by what — ship-first to everyone is a fraud magnet, so
  the gate ties to return-fraud-scoring or account standing.

### [vendor-rmas.md](../../extensions/returns-and-refunds/vendor-rmas.md)

- **Claim.** The **outbound mirror** of a customer return — units routed back to the supplier that
  supplied them, for credit / replacement / warranty repair. **Inherits the Supplier party** from
  [supplier-and-vendor.md](../../extensions/product-catalog/supplier-and-vendor.md).
- **Attaches to.** `return-request.model.ts` (a sibling RMA shape) and the restock gateway port (the
  *outbound* counterpart — a ship-to-supplier decrement in the same ledger).
- **Hardest to reverse.** Which module owns `VendorReturn` — the returns trigger or the supplier
  counterparty; the supplier subsystem is the more natural owner once it exists.

### [refund-to-store-credit.md](../../extensions/returns-and-refunds/refund-to-store-credit.md)

- **Claim.** A refund whose *destination* is the store-credit ledger rather than the card gateway.
  **Inherits the ledger wholesale** from
  [gift-cards-and-store-credit.md](../../extensions/order-management/gift-cards-and-store-credit.md); its own contribution is
  the refund-path attachment, nothing more.
- **Attaches to.**
  [`refund.model.ts`](../../../apps/retail-microservice/src/modules/orders/domain/refund.model.ts) — on
  the **orders** side, a destination discriminator replacing the `gatewayReference` call with a ledger
  credit.
- **Hardest to reverse.** Destination-on-`Refund` (one concept, two destinations, reuses the over-refund
  ceiling) vs. a separate credit action (keeps `Refund` strictly card-reversal).

### [return-fraud-scoring.md](../../extensions/returns-and-refunds/return-fraud-scoring.md)

- **Claim.** Score a return at Open — block / hold / allow — against wardrobing, serial returns, and
  empty-box fraud. **Inherits the `RISK_SCORING_GATEWAY` seam** from
  [fraud-and-risk-scoring.md](../../extensions/order-management/fraud-and-risk-scoring.md), pointed at a `ReturnRequest`.
- **Attaches to.** `return-request.model.ts` (the verdict maps onto the existing
  `REQUESTED → AUTHORIZED`/`REJECTED` fork) and the returns `application/use-cases/` (the Open use case
  places the call).
- **Hardest to reverse.** Score at Open or at Inspect — Open catches abuse pre-authorize; Inspect catches
  empty-box/swap fraud that only shows on arrival; the honest answer may be both.

## Exchange vs. replacement vs. advance replacement

The cluster's whole conceptual difficulty is one table. Three files circle *how a shop gives the customer a
different thing*; the split is owned by
[exchanges-as-first-class-entity.md](../../extensions/returns-and-refunds/exchanges-as-first-class-entity.md) and the other two
link it rather than re-arguing it:

| | Replacement order | Exchange (entity) | Advance replacement |
| --- | --- | --- | --- |
| **What it is** | A *new* `Order` ships the substitute, linked to the original | *One aggregate* binds the inbound return and the outbound order into one deal | An exchange (or replacement) whose outbound leg **ships first** |
| **Binding** | None — two records that reference each other | Strong — the two legs cannot close independently | Strong, plus a timeline inversion |
| **Timing** | Outbound any time | Outbound after the return is received (default) | Outbound **before** the return arrives |
| **Core problem** | Already expressible; how to link cleanly | Anti-drift + money reconciliation (even/up/down swap) | **Credit risk + stock commitment** — not a modelling problem |
| **New machinery** | A link field on `Order` | An `Exchange` aggregate + line mapping + settlement | A payment hold + a deadline sweep on top of an exchange |
| **Owned by** | [replacement-orders-distinct-entity.md](../../extensions/order-management/replacement-orders-distinct-entity.md) (Order Management) | [exchanges-as-first-class-entity.md](../../extensions/returns-and-refunds/exchanges-as-first-class-entity.md) (this cluster) | [advance-replacement.md](../../extensions/returns-and-refunds/advance-replacement.md) (this cluster) |

The test the three guides had to pass: **distinguishable from their first paragraph.** Replacement = a new
order, no timing rule. Exchange = one binding entity so the swap can't drift. Advance = the outbound ships
before the return, which is a risk problem layered on the exchange. None re-models what an earlier one owns.

## What the no-import boundary costs an RMA extension

`returns/` may not import `orders/`; it reads order data through `RETURN_ORDER_READER`'s flat snapshot.
That boundary is cheap for the current RMA flow — the snapshot carries exactly what Open needs — but every
extension that wants *more* pays the same toll: **grow a reader/gateway port, never reach across.** Four of
these six sketches pay it, and the two that don't are instructive about why:

| Guide | Needs data behind a boundary? | How it pays the toll |
| --- | --- | --- |
| exchanges | Yes — the outbound `Order`'s state and the returned lines' **unit prices** (the snapshot carries no price) | Grows `RETURN_ORDER_READER` (line price) and reads the replacement order's state by id through a reader, never importing `Order` |
| advance-replacement | Yes — the order **total** and **payment standing** for the credit hold (the snapshot carries no amounts) | Grows the reader with amounts / payment status, and authorizes the hold through the existing `PAYMENT_GATEWAY` seam cross-module |
| return-fraud-scoring | Yes — the customer's **return + order history** as scoring signal (order value not in the snapshot) | Grows the reader with order value and computes history from `RETURN_REQUEST_REPOSITORY`, passing **id-only** signals out |
| vendor-rmas | Yes — the **supplier** who supplied the variant (never in `orders/` at all) | Grows a *supplier* seam (`supplier-and-vendor.md`) with the same read-through-a-port discipline — a different port, same rule |
| repair-workflows | **No** — returns-internal | Disposition + deferred restock; the variant it needs is already in the snapshot and the restock payload |
| refund-to-store-credit | **No** — attaches on the *orders* side | It extends `Refund` where the refund is issued, so there is no returns→orders reach to make |

The lesson the reader should take: the no-import boundary is not free, but its cost is **predictable and
uniform** — an extension that needs a fact the snapshot lacks widens the port by that fact, and the fact
travels as an opaque id or a scalar, never as an imported aggregate or a PII field. Repair-workflows and
refund-to-store-credit pay nothing because one never leaves the returns module and the other never enters
it — which is exactly why `Refund` was put in `orders/` in the first place (ADR-032).

## Cross-links and ownership, this cluster

- `exchanges-as-first-class-entity.md` → `replacement-orders-distinct-entity.md` — inherits
  "a replacement is a new `Order` linked to the original"; **owns** the exchange/replacement/advance split.
- `advance-replacement.md` → `exchanges-as-first-class-entity.md` (same cluster, the split owner) **and**
  `replacement-orders-distinct-entity.md` — composes both, adds only the ship-first ordering and the risk
  hold.
- `vendor-rmas.md` → `supplier-and-vendor.md` — inherits the Supplier / Vendor party.
- `refund-to-store-credit.md` → `gift-cards-and-store-credit.md` — inherits the store-credit ledger
  wholesale.
- `return-fraud-scoring.md` → `fraud-and-risk-scoring.md` — inherits the `RISK_SCORING_GATEWAY` port and
  the block/hold/allow verb set.

Every link points **backward** to a guide an earlier session (or, for advance-replacement, the same
session) already authored — which is what keeps the structure check's link resolution and index bijection
green at every stage of filling the folder. No guide in this cluster links forward.
