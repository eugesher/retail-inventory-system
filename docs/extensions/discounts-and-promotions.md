---
title: Discounts and promotions
cluster: Pricing & Promotions
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/catalog-microservice/src/modules/pricing/domain/price.model.ts
  - apps/retail-microservice/src/modules/orders/domain/order-line.model.ts
  - apps/retail-microservice/src/modules/cart/
---

# Discounts and promotions

## Description

A **promotion** is a conditional price reduction: "20% off jackets this week", "buy two get one free",
"£10 off orders over £100 for members". It is the machinery every retail platform grows once a flat price
list stops selling — Shopify's Discounts, Adobe Commerce's Cart Price Rules and commercetools' product and
cart discounts are all the same shape: a rule with conditions, evaluated at checkout, that lowers what the
customer pays without rewriting the catalogue.

This guide **owns the promotion engine** for the whole cluster — where a discount is computed, whether it
touches the price ledger, and what a discounted order stores so it can be reconstructed years later. Four
of the other Pricing & Promotions guides ([coupons-and-discount-codes.md](coupons-and-discount-codes.md),
[customer-group-and-tiered-pricing.md](customer-group-and-tiered-pricing.md),
[b2b-contract-pricing.md](b2b-contract-pricing.md), [msrp-vs-sale-price.md](msrp-vs-sale-price.md))
inherit those answers rather than re-deriving them, so this guide has to give them **concretely**. The
single hardest fact it settles: **a promotion is not an append to the `price` ledger.** The reasons are in
the code, not in taste, and the whole cluster rests on them.

## Business needs

- **Promotions are how retail sells** — seasonal sales, member pricing, bundle deals and threshold offers
  are not edge cases; a shop that can only quote one price per variant cannot run a marketing calendar.
- **Conditions are the whole point** — "20% off, but only jackets, only this week, only for members over
  £100" is a rule with predicates, not a new number in a table. The engine's value is evaluating those
  predicates at the right moment and stacking (or refusing to stack) the results.
- **The charged price and the reason must survive** — an order placed under a promotion has to reconstruct,
  from immutable data, *what* was taken off and *why*, for refunds, accounting and disputes long after the
  promotion has ended.
- The threshold: a shop with a fixed price list and no marketing calendar never needs this; the first
  "run a sale" or "give members 10% off" is where a conditional reduction has to exist as a first-class,
  evaluable thing rather than a hand-edited price.

## Attachment points in the current core

- **The `Price` ledger at
  `apps/catalog-microservice/src/modules/pricing/domain/price.model.ts` — the thing a discount is *not* an
  append to.** The ledger is append-only-for-history, scoped by exactly `(variantId, currency)`, and holds
  **at most one open row per scope** — enforced by an app-level close-in-transaction *and* a
  generated-column UNIQUE backstop `open_scope_key` (ADR-026 §3). A promotion cannot live here: its scope
  is a cart, a customer, a code or a condition, none of which `(variantId, currency)` can express, and a
  "promo price" appended as a second open row for the same scope would fail the UNIQUE backstop with a
  duplicate-key error. The ledger answers *"what is this variant's list price right now"*; a promotion is a
  reduction applied *on top* of that answer.
- **The order's discount seams — already cut, already captured-not-computed.**
  `OrderLine` at `apps/retail-microservice/src/modules/orders/domain/order-line.model.ts` carries a
  `discountAmountMinor` field (`readonly`, default `0`) inside its total invariant
  `lineTotalMinor = unitPriceMinor × quantity + taxAmountMinor − discountAmountMinor`; `Order`
  (`order.model.ts`) carries `discountTotalMinor` inside
  `grandTotalMinor = subtotal + tax + shipping − discount`. These are the **exact twin** of the tax seams
  [tax-computation-engine.md](tax-computation-engine.md) fills: they exist, default to `0`, and freeze at
  placement. **The storage for a discount is already there** — what is missing is the engine that computes
  the number.
- **The cart totalling path at `apps/retail-microservice/src/modules/cart/`.** `Cart.total` is a pure
  subtotal projection today (`Σ unitPriceSnapshotMinor × quantity`, no discount field). Promotion display —
  what the customer sees *before* checkout — is a re-evaluation on the mutable cart; the frozen figure is
  computed again and written into the immutable order at placement.
- **The price read seam.** The base price a promotion reduces is resolved through pricing's
  `SelectApplicablePrice` policy (highest `priority`, then latest `validFrom`); the catalog side has its
  own parameterized read of the same table through `ACTIVE_PRICE_PROBE`. A promotion reduces the *selected*
  price; it does not become a competing candidate in that resolution.

## Implementation sketch

- **Where a discount is computed: at checkout, in retail, never at price selection.** The pricing ledger
  produces the base price; a **`PromotionRule` aggregate** (a new retail-side concept — conditions,
  reward, validity window, stacking policy) is evaluated at **cart totalling** for display and
  **re-evaluated and frozen at order placement**. This mirrors exactly how
  [tax-computation-engine.md](tax-computation-engine.md) treats tax: computed at place-time, between
  snapshotting the lines and deriving the totals, then immutable. It is *not* computed at price selection —
  the ledger has no notion of a cart or a customer to condition on.
- **A promotion is a `PromotionRule`, not a `price` row.** The rule owns its predicates (product/collection
  scope, customer-group scope, cart-threshold, date window) and its reward (percentage-off, amount-off,
  free-line). It is evaluated; it is never appended to the price ledger, for the three code reasons above.
  The **one** thing that *is* a ledger row is a **scheduled sale for everyone** — a genuine base-price
  change with no conditions — which `SetPrice` already expresses through `validFrom`/`validTo` and
  `priority`. The line between the two (a sale is a new list price; a promotion is a conditional reduction
  on top) is the one [msrp-vs-sale-price.md](msrp-vs-sale-price.md) leans on.
- **What is stored on the order.** The computed reduction lands in the existing `discountAmountMinor`
  (per line) and `discountTotalMinor` (header) seams. Alongside it, the order stores a **promotion
  reference / snapshot** — which rule(s) applied and their computed effect — so the "why" reconstructs from
  immutable data, the same way tax stores its calculation reference and `Payment.gatewayReference` is
  stored-but-never-parsed. A placed order never recomputes; a later change to the rule cannot alter it.
- **Events ride `ris.events`.** Applying a promotion at placement emits a dotted
  `<service>.<aggregate>.<action>` event — e.g. `retail.promotion.applied` — carrying rule ids, order/line
  ids and amounts. Authoring a rule emits `catalog.promotion.created` / `.updated` if the engine lives
  catalog-side. **No PII in the payload** (ADR-037): a member-only promotion carries the `customerId`, never
  a name or email.
- **Shared types** (the rule definition, the applied-promotion snapshot) go under
  `libs/contracts/<cluster>/`, alongside the price contracts that already live in `libs/contracts/catalog/`.
- **Caching.** A resolved cart total under active promotions is a candidate for cache-aside, but only
  behind a `CACHE_KEYS` builder in its own version segment — never a key literal, and invalidated on any
  rule or cart change.

## Open design questions

- **Where does the engine live — catalog/pricing or retail?** Rule *authoring* is naturally catalog-side
  (next to the price it modifies), but rule *evaluation* needs the live cart, which is retail-side. The
  honest split is probably authoring in one module and a read-through evaluation port in the other — but it
  is a real boundary decision, not a given.
- **Stacking and precedence.** When three promotions match one cart, do they combine, does the best one
  win, or does the shop configure precedence? This is the single most error-prone corner of every
  promotions engine and the rule the order must record precisely, because "why was this the price" has to
  survive.
- **Whole-cart vs. per-line discounts.** "£10 off the order" has to be *apportioned* back to lines so each
  `discountAmountMinor` stays truthful and a partial refund can compute the proportional discount — the
  same apportionment problem tax refunds face.
- **Coupon vs. automatic.** A promotion can be automatic (applies whenever conditions match) or gated by a
  code — the code layer is [coupons-and-discount-codes.md](coupons-and-discount-codes.md), which inherits
  this engine and adds only the code that unlocks a rule.
- **Interaction with a scheduled sale.** If a variant is already on a ledger sale *and* a promotion matches,
  does the promotion reduce the sale price or the original? The base the engine reduces has to be defined
  unambiguously against the ledger's resolved answer.

## Effort sketch

`subsystem-scale (5+ capabilities)` — the `PromotionRule` aggregate and its predicate/reward model, the
checkout-time evaluation at cart totalling and the frozen re-evaluation at placement, the apportionment of
cart-level discounts back to lines, the applied-promotion snapshot on the order, and the stacking policy.
It is a subsystem because it settles the foundations four other guides in this cluster build on — where a
discount is computed, that it is not a ledger row, and what the order stores — and each of those answers is
load-bearing for the guides that inherit it.
