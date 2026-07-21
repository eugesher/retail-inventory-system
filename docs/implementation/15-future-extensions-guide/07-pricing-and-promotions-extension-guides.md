# 07 — Pricing & Promotions extension guides

The eight Pricing & Promotions guides under [`docs/extensions/`](../../extensions/) sketch how a business
would grow pricing past the universal core. The whole cluster hangs off one guide —
[discounts-and-promotions.md](../../extensions/pricing-and-promotions/discounts-and-promotions.md) owns the promotion engine, and
four of the other seven inherit its answers rather than re-deriving them. That is why it was authored first
and at `subsystem-scale`: if it decided where a discount is computed and what an order stores wrongly, four
sketches would inherit the mistake.

Every field, token, builder and routing key named below was read out of the source this session, because
the point-in-time notes in this folder describe a capability at ship time, not necessarily its shape today.
The single fact that shapes almost every guide here is the one the cluster's hardest question turns on, and
it is a property of the code, not a preference:

**The `Price` ledger is append-only-for-history, scoped by exactly `(variantId, currency)`, with at most
one open row per scope** — enforced by an app-level close-in-transaction *and* a generated-column UNIQUE
backstop `open_scope_key` (`CASE WHEN valid_to IS NULL THEN CONCAT(variant_id, ':', currency) ELSE NULL
END`). A price change never edits a row: it closes the predecessor's interval and appends a successor
(ADR-026). Resolution — one applicable price from the candidates — is highest `priority`, then latest
`validFrom`, and lives in the use case, not in SQL.

## Why a discount is not a `price` row

This is the single hardest thing in the cluster, and four guides depend on the answer. A promotion is **not**
an append to the price ledger, for three reasons that are all in the code:

1. **The ledger scope cannot express a promotion.** A `Price` is scoped by exactly `(variantId, currency)`
   (ADR-026 §2). A promotion is scoped by a cart, a customer, a code, or a condition — none of which that
   two-part key can hold. There is nowhere on the ledger to record "20% off, members only, over £100".
2. **A competing open row collides with the backstop.** If a promotion tried to append a "promo price" as a
   second open row for the same `(variantId, currency)`, the generated-column UNIQUE `open_scope_key` would
   reject the second insert with a duplicate-key error. The invariant that keeps "the current price" of a
   scope unambiguous is precisely what forbids a second open price for it.
3. **The order already has the seam a discount belongs in.** `OrderLine.discountAmountMinor` and
   `Order.discountTotalMinor` already exist — `readonly`, default `0`, inside the total invariants
   `lineTotalMinor = unitPriceMinor × quantity + taxAmountMinor − discountAmountMinor` and
   `grandTotalMinor = subtotal + tax + shipping − discount`. They are captured-not-computed, the exact twin
   of the tax seams [tax-computation-engine.md](../../extensions/order-management/tax-computation-engine.md) fills. A discount
   is computed at checkout and **frozen** into these existing fields at placement.

So a discount is computed **at checkout, in retail** — evaluated on the mutable cart for display and
re-evaluated and frozen into the immutable order at placement — never at price selection, and never as a
ledger append. What the order stores is the reduction (`discountAmountMinor`/`discountTotalMinor`) plus a
promotion reference/snapshot for the "why", reconstructable from immutable data years later.

**The one thing that *is* a ledger row:** a **scheduled sale for everyone** — an unconditional base-price
change — which `SetPrice` already expresses through `validFrom`/`validTo` and `priority`. The line between a
*sale* (a new list price on the ledger) and a *promotion* (a conditional reduction on top, computed at
checkout) is the line [msrp-vs-sale-price.md](../../extensions/pricing-and-promotions/msrp-vs-sale-price.md) leans on for its
compare-at concept.

## Tender versus price adjustment

The cluster's second settled distinction, and the reason it has **eight** guides, not nine. The exclusions
register lists "gift cards (as tender)" under Pricing & Promotions, but a gift card is already covered from
the order-management side by
[gift-cards-and-store-credit.md](../../extensions/order-management/gift-cards-and-store-credit.md). The two are not the same
kind of thing:

| | Price adjustment (this cluster) | Tender (order management) |
| --- | --- | --- |
| **What it does** | *Lowers what is owed* | *Pays what is owed* |
| **Example** | A coupon, a promotion, a member price | A gift card, store credit |
| **Where it lands** | `discountAmountMinor` / `discountTotalMinor` on the order | a `Payment` row with an opaque `method` |
| **Model** | evaluated at checkout, frozen into the order totals | a balance/ledger spent via `PAYMENT_GATEWAY` |
| **Owned by** | [discounts-and-promotions.md](../../extensions/pricing-and-promotions/discounts-and-promotions.md) / [coupons-and-discount-codes.md](../../extensions/pricing-and-promotions/coupons-and-discount-codes.md) | [gift-cards-and-store-credit.md](../../extensions/order-management/gift-cards-and-store-credit.md) |

`coupons-and-discount-codes.md` states this in one sentence and links the gift-card guide rather than
duplicating it: a coupon reduces the price and never becomes a `Payment`; a gift card is a tender and never
touches `discountAmountMinor`. So the cluster links the gift-card guide; it does not write a second one.

## The eight guides

### [discounts-and-promotions.md](../../extensions/pricing-and-promotions/discounts-and-promotions.md)

- **Claim.** Owns the promotion engine: a `PromotionRule` aggregate evaluated at checkout, computed into the
  order's existing discount seams, **never** appended to the price ledger. Settles where a discount is
  computed, whether it touches the ledger (no), and what the order stores. `subsystem-scale`.
- **Attaches to.** `price.model.ts` (the ledger it is *not* an append to), `order-line.model.ts` (the
  `discountAmountMinor` seam), and the `cart/` totalling path.
- **Links.** [tax-computation-engine.md](../../extensions/order-management/tax-computation-engine.md) as the
  captured-not-computed precedent — the only backward link; it links **none** of its four dependents.

### [coupons-and-discount-codes.md](../../extensions/pricing-and-promotions/coupons-and-discount-codes.md)

- **Claim.** A code that unlocks a promotion — the thin redemption/caps layer above the engine. Owns the
  **tender-vs-adjustment** one-sentence distinction.
- **Attaches to.** The `cart/` module (a code is a cart operation) and `order-line.model.ts`.
- **Links.** [discounts-and-promotions.md](../../extensions/pricing-and-promotions/discounts-and-promotions.md) (inherits the
  engine) and [gift-cards-and-store-credit.md](../../extensions/order-management/gift-cards-and-store-credit.md) (why a gift
  card is a tender and a coupon an adjustment).

### [customer-group-and-tiered-pricing.md](../../extensions/pricing-and-promotions/customer-group-and-tiered-pricing.md)

- **Claim.** Scopes a price to a customer group — literally the `priceScope` axis ADR-026 §2 reserved by
  name and ruled out for now. The `open_scope_key` backstop widens with the scope so a public and a
  wholesale open price coexist.
- **Attaches to.** `price.model.ts` (scope + priority).
- **Links.** [customer-segments-and-tiers.md](../../extensions/customer-and-identity/customer-segments-and-tiers.md) (inherits the
  segment; a tier's price is the "benefit" the segments guide left open) and
  [discounts-and-promotions.md](../../extensions/pricing-and-promotions/discounts-and-promotions.md).

### [b2b-contract-pricing.md](../../extensions/pricing-and-promotions/b2b-contract-pricing.md)

- **Claim.** Account-scoped, contract-term prices on the ledger — the same `priceScope` axis, keyed to a
  `BusinessAccount` and rolling down its tree. Adds only the pricing attachment.
- **Attaches to.** `price.model.ts`.
- **Links.** [b2b-quote-po-credit-terms.md](../../extensions/order-management/b2b-quote-po-credit-terms.md) (the account
  party), [b2b-company-hierarchies.md](../../extensions/customer-and-identity/b2b-company-hierarchies.md) (the tree to scope
  against), and [discounts-and-promotions.md](../../extensions/pricing-and-promotions/discounts-and-promotions.md).

### [dynamic-ai-pricing.md](../../extensions/pricing-and-promotions/dynamic-ai-pricing.md)

- **Claim.** A repricing engine that **writes rows, never mutates them** — automation driving the existing
  `SetPrice` path. The append-only ledger is what makes an automated change auditable, not an obstacle.
- **Attaches to.** `price.model.ts` (the append-only ledger) and the `ACTIVE_PRICE_PROBE` publish precondition
  it must not break.
- **Links.** None — it stands on the ledger directly.

### [tax-rate-tables.md](../../extensions/pricing-and-promotions/tax-rate-tables.md)

- **Claim.** The **internal-rate-table alternative** to a tax engine — owns the `(jurisdiction × tax
  category) → rate` data behind the same `TAX_ENGINE` port, effective-dated like a price. Keeps `TaxCategory`
  a label with no rate.
- **Attaches to.** `tax-category.model.ts` (a label with no rate, ADR-026 §6).
- **Links.** [tax-computation-engine.md](../../extensions/order-management/tax-computation-engine.md) (owns the call-out seam
  and storage). Both point at the root `README.md`'s `Not built yet` row *"Tax rates and jurisdictions —
  `TaxCategory` is a label only"*; neither duplicates the other.

### [currency-conversion.md](../../extensions/pricing-and-promotions/currency-conversion.md)

- **Claim.** Sell per currency over the ledger's existing `(variantId, currency)` scope; FX is always an
  **explicit** step, never a silent conversion. The guide most at risk of writing a currency literal — it
  must keep every default flowing through the three tokens.
- **Attaches to.** `price.model.ts` (per-currency scope) and `order.model.ts` (immutable `currency`).
- **Links.** None required — the rail it honours is the three-token default and immutable `Order.currency`.

### [msrp-vs-sale-price.md](../../extensions/pricing-and-promotions/msrp-vs-sale-price.md)

- **Claim.** Owns the **compare-at** concept — the struck-through "was" price, derived from the ledger's
  `priority` ordering and closed-interval history rather than a hand-typed field. `1 capability`.
- **Attaches to.** `price.model.ts` (priority ordering).
- **Links.** [discounts-and-promotions.md](../../extensions/pricing-and-promotions/discounts-and-promotions.md) — defers the actual
  reduction machinery (and the sale-vs-promotion line) to the engine; owns only the display-facing reference.

## Cross-links and ownership, this cluster

- Four guides link the engine, and it links none of them back: `coupons`, `customer-group`, `b2b-contract`
  and `msrp` all link [discounts-and-promotions.md](../../extensions/pricing-and-promotions/discounts-and-promotions.md);
  `dynamic-ai` and `currency-conversion` stand on the ledger directly and do not.
- The two guides that lift the `priceScope` axis ADR-026 reserved — `customer-group` (group scope) and
  `b2b-contract` (account scope) — share the mechanism: widen the scope key, widen the `open_scope_key`
  backstop to match, prefer the more specific scope in resolution. `customer-group` states it; `b2b-contract`
  reuses it and adds the account party and its tree.
- `tax-rate-tables` and `tax-computation-engine` are a **row-and-guide pair** across two clusters: the engine
  guide owns the call-out and storage, the rate-tables guide owns the rate data behind the same port, and
  both link the one `Not built yet` row (ADR-055's neither-restates-the-other rule).
- Every link points **backward** — to a guide an earlier session authored, or (for the four engine-dependents)
  to `discounts-and-promotions.md`, written first this session. No guide in this cluster links forward.
