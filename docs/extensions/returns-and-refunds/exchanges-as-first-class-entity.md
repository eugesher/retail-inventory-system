---
title: Exchanges as a first-class entity
cluster: Returns & Refunds
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/returns/domain/return-request.model.ts
  - apps/retail-microservice/src/modules/returns/domain/return-line.model.ts
---

# Exchanges as a first-class entity

## Description

An **exchange** is one transaction that spans *both* an inbound return and an outbound shipment: the
customer sends a thing back and gets a different thing in return — a different size, a different colour,
a replacement of the same item — in a single agreed swap. The universal core can already express the two
halves separately: a `ReturnRequest` walks the goods back in, and (per
[replacement-orders-distinct-entity.md](../order-management/replacement-orders-distinct-entity.md)) a new `Order` ships the
substitute out. What it *cannot* express is that the two are **one deal** — that the outbound must not
ship, or must ship, in a defined relationship to the inbound. An exchange as a first-class entity is the
aggregate that binds them so they cannot silently drift apart.

**This guide owns the three-way distinction** the whole cluster circles, stated once here so
[advance-replacement.md](advance-replacement.md) and
[replacement-orders-distinct-entity.md](../order-management/replacement-orders-distinct-entity.md) link it rather than
re-argue it:

- **Replacement order** — the customer returns goods; a *new* `Order` ships the substitute. Already
  expressible today, and [replacement-orders-distinct-entity.md](../order-management/replacement-orders-distinct-entity.md)
  owns that argument. There is no binding entity: the return and the replacement order are two records
  that happen to reference each other.
- **Exchange as an entity** (*this guide*) — one aggregate spanning the inbound return and the outbound
  goods, with a settled money direction, so the two **cannot** be closed independently. The subject here.
- **Advance replacement** — the substitute ships *before* the return arrives.
  [advance-replacement.md](advance-replacement.md) owns that; it is a credit-risk and stock-commitment
  problem layered on top of this one, not a different modelling of the swap.

If these three cannot be told apart from their first paragraph, they have not been written yet.

## Business needs

- **The commonest return is not a refund** — apparel and footwear customers overwhelmingly want a
  *different size*, not their money back. Forcing that through refund-then-rebuy loses the sale and the
  margin; an exchange keeps both.
- **A guaranteed swap** — the customer must get the replacement, and the shop must get the original back;
  neither side should be able to complete half the deal. A binding entity is what makes "I returned it
  but they never sent the new one" unrepresentable.
- **Even, up, and down swaps** — a same-price swap moves no money; an upgrade means the customer owes the
  difference; a downgrade means the shop refunds it. All three are one capability, and the money
  direction is the exchange's own state, not an afterthought.
- The threshold: the first time staff process "send it back, we'll ship the other size" as two
  disconnected records and one of them falls through the cracks is where an exchange entity earns itself.

## Attachment points in the current core

- **The `ReturnRequest` aggregate at
  `apps/retail-microservice/src/modules/returns/domain/return-request.model.ts`.** The inbound half of an
  exchange *is* an RMA: it walks `REQUESTED → AUTHORIZED → RECEIVED → INSPECTED → CLOSED` exactly as a
  refund-bound return does. An exchange does not replace that lifecycle — it **references** a
  `ReturnRequest` and adds the outbound obligation beside it. The RMA's terminal `CLOSED` is where an
  exchange would normally settle, but an exchange must also track that the outbound order shipped.
- **The `ReturnLine` disposition at
  `apps/retail-microservice/src/modules/returns/domain/return-line.model.ts`.** Each returned line already
  records a `disposition` at inspection (`restock` / `scrap` / `quarantine`). An exchange constrains
  nothing new on the *inbound* line — a returned-for-exchange item still restocks or scraps like any
  other. What the exchange adds is the mapping from each inbound line to the **outbound** substitute
  line, which the `ReturnLine` does not carry.
- **The hard boundary: `returns/` may not import `orders/`.** The outbound substitute is an `Order`, and
  an `Order` lives in the orders module behind a lint-enforced isolation line
  ([replacement-orders-distinct-entity.md](../order-management/replacement-orders-distinct-entity.md) attaches on that
  side). So the exchange aggregate cannot *hold* an `Order`. It holds the **opaque `orderId`** of the
  replacement and reads what it needs through a reader port — the same discipline `RETURN_ORDER_READER`
  already uses to read the original order without importing it.

## Implementation sketch

- **An `Exchange` aggregate** keyed to a `returnRequestId` (the inbound RMA) and a replacement `orderId`
  (the outbound `Order`), both **opaque ids** — never the imported aggregates. It carries the money
  direction (`even` / `customer-owes` / `shop-refunds`) and the difference amount in minor units, and a
  status that tracks *both* legs: the return cannot be considered settled until the outbound order has a
  fulfilment, and the outbound must not close until the return is (at least) authorized.
- **Where it lives is the load-bearing call** (see Open questions). Because `returns/` ↛ `orders/` and,
  symmetrically, `orders/` should not import `returns/`, an aggregate that owns *both* ids sits most
  naturally as a thin coordinator that references each side by id and drives them through the existing
  RPCs, not inside either module.
- **The money leg reuses what exists.** An even swap moves nothing. A downgrade (`shop-refunds`) issues a
  `Refund` through the orders-side refund path — the exchange does not re-model refunding, it triggers
  the existing one, exactly as a return that closes with money owed does today. An upgrade
  (`customer-owes`) authorizes an additional `Payment` on the replacement order through the existing
  `PAYMENT_GATEWAY` seam.
- **Restock is unchanged.** The inbound goods restock through `INVENTORY_RESTOCK_GATEWAY` on the
  disposition the same way any RMA line does — an exchange adds no new stock path, it adds the outbound
  *allocation*, which the replacement `Order` already performs.
- **Events** ride `ris.events` if added — `retail.exchange.opened` / `.settled`, carrying
  `exchangeId` / `returnRequestId` / `orderId` and the money direction, **ids and amounts only, never
  PII** (the notification fan-out resolves contact details from the customer id, as the existing return
  events do).
- **Shared types** (the exchange view, the line-mapping shape) under `libs/contracts/retail/`.

## Open design questions

- **Where does the `Exchange` aggregate live, given `returns/` ↛ `orders/`?** It references an RMA in
  `returns/` and an `Order` in `orders/`, and may import neither. A thin coordination module that owns the
  `Exchange` row and drives both sides by id through their RPCs is the boundary-respecting answer; folding
  it into `returns/` (with the outbound order reached through a grown reader port) is the alternative. The
  choice decides which module's lint rules the entity answers to.
- **One aggregate or a linked pair?** A single `Exchange` spanning both legs is the strongest anti-drift
  guarantee but couples two lifecycles; a pair of records (RMA + replacement order) with a shared
  correlation and a reconciliation check is looser but keeps each module's aggregate pure. This is the
  same "one entity vs. two linked records" tension `replacement-orders-distinct-entity` settles for
  replacements — an exchange raises the stakes because the *money* must reconcile too.
- **What zero-values the replacement order on an even swap?** Inherited, unresolved, from
  [replacement-orders-distinct-entity.md](../order-management/replacement-orders-distinct-entity.md): zero-priced lines vs. a
  100% order discount. The exchange makes it sharper — an even swap must net to zero *including* the
  price-difference math, so the choice interacts with how the difference is computed.
- **Order of operations for an even/down swap** — ship the replacement on authorize, or only after the
  return is received? Shipping early is [advance-replacement.md](advance-replacement.md)'s problem; the
  default here is ship-after-receipt, and an exchange that opts into shipping early *is* an advance
  replacement.

## Effort sketch

`2–3 capabilities` — the `Exchange` aggregate with its two-legged status and money direction; the
inbound-to-outbound line mapping; and the settlement path that reuses the refund and payment seams for
the price difference. It is more than one capability because the money-reconciliation and the
cross-module coordination are each non-trivial, but it is bounded: every leg reuses machinery the core
already has (the RMA lifecycle, the replacement order, the refund path), so the new work is the *binding*,
not the parts.
