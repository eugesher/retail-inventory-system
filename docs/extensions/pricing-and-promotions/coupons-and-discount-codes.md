---
title: Coupons and discount codes
cluster: Pricing & Promotions
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/cart/
  - apps/retail-microservice/src/modules/orders/domain/order-line.model.ts
---

# Coupons and discount codes

## Description

A **coupon** is a promotion behind a code: `SUMMER20`, a single-use `WELCOME10`, a unique per-customer
recovery code. The reduction it unlocks is exactly a promotion — this guide does **not** own the
discount engine, it inherits it from [discounts-and-promotions.md](discounts-and-promotions.md). What it
adds is the thin layer above: the code that gates a rule, the redemption bookkeeping that enforces
"single-use" or "once per customer", and the checkout step where a shopper types a code and the cart
re-totals. Shopify's discount codes, Adobe Commerce's coupon codes and commercetools' `DiscountCode` are
all this shape — a code is a *key* to a promotion, never a second kind of promotion.

The distinction that keeps this cluster at eight guides and not nine: **a coupon is a price adjustment;
a gift card is a tender.** A coupon lowers what is owed and lands in `discountAmountMinor`; a gift card
*pays* what is owed and lands as a `Payment` — which is why gift cards live in order management
([gift-cards-and-store-credit.md](../order-management/gift-cards-and-store-credit.md)) and coupons live here.

## Business needs

- **Acquisition and recovery** — a welcome code converts a first-time visitor, an abandoned-cart code wins
  back a lapsed one; both need a code a customer can enter, not an automatic rule.
- **Controlled, trackable distribution** — a code printed on a flyer, emailed to a segment, or issued
  one-per-customer needs redemption limits and attribution the marketer can measure.
- **Single-use and per-customer caps** — "one per customer", "first 100 redemptions", "expires Sunday" are
  redemption rules the code layer enforces, distinct from the discount's own conditions.
- The threshold: automatic promotions cover storewide sales; the first *targeted* offer that must not apply
  to everyone — a code you hand to one cohort — is where a coupon layer has to exist.

## Attachment points in the current core

- **The cart module at `apps/retail-microservice/src/modules/cart/`.** Entering a code is a cart operation:
  the code is validated, the promotion it unlocks is evaluated by the inherited engine, and `Cart.total`
  reflects the reduction for display. A code is held on the mutable cart until placement, exactly where the
  cart already holds its lines and its OCC `version`.
- **The order's discount seams at
  `apps/retail-microservice/src/modules/orders/domain/order-line.model.ts`.** A redeemed coupon's effect
  freezes into the same `discountAmountMinor` / `discountTotalMinor` fields any promotion uses — a coupon
  adds no new money field, because it *is* a promotion with a code in front of it. The applied-promotion
  snapshot the order stores records which code was redeemed, for reconstruction.
- **The promotion engine** ([discounts-and-promotions.md](discounts-and-promotions.md)) — inherited whole.
  The `PromotionRule`, its predicates and reward, the checkout-time evaluation and the frozen order snapshot
  are all defined there. This guide references a rule by id and never re-models it.

## Implementation sketch

- **A `Coupon` / `DiscountCode` entity keyed to a `PromotionRule`.** The code carries the redemption
  policy — total-use cap, per-customer cap, validity window — and points at the rule that supplies the
  actual reduction. Many codes can point at one rule (a campaign with per-customer unique codes); one code
  can gate one rule.
- **Redemption is a guarded, idempotent write.** Applying a code checks its caps against a redemption
  ledger (or counter), and the *placement* that consumes it must be idempotent so a checkout retry cannot
  double-count a single-use code — the same request-level idempotency discipline the money-moving writes
  already use (ADR-036). Concurrent redemptions of the last unit of a capped code are resolved by
  version-checked OCC, the no-oversell rule applied to a redemption count.
- **The evaluation is the engine's, not the code's.** The code validates and resolves to a rule; the rule
  is evaluated by the inherited engine at cart totalling and re-frozen at placement. The code layer never
  computes a reduction itself.
- **Events ride `ris.events`** — `retail.coupon.redeemed` carrying the code id, rule id, cart/order id and
  amount. **No PII** (ADR-037): a per-customer code carries the `customerId`, never the recipient's contact
  details.
- **Shared types** (the code view, the redeem command) under `libs/contracts/<cluster>/`.

## Open design questions

- **When is a single-use code "spent" — at apply or at placement?** Reserving it at apply blocks other
  carts but strands the code if the cart is abandoned; consuming it only at placement risks two carts
  redeeming the last unit. This is a reservation-vs-consume trade the redemption ledger has to pick.
- **Unique-code generation at scale** — a million per-customer codes need a collision-safe, guess-resistant
  format and a bulk-issue path; the format is a security decision, not a schema one.
- **Stacking a code with automatic promotions** — can `SUMMER20` combine with an already-active storewide
  sale? This defers to the engine's stacking policy, but the code layer must decide whether a code is
  "exclusive".
- **Attribution across channels** — the same logical offer distributed as many codes needs reporting that
  rolls redemptions back up to the campaign, which shapes how codes reference rules.

## Effort sketch

`2–3 capabilities` — the code entity and its redemption policy, the guarded idempotent redemption path, and
the cart step that applies a code and re-totals. It stays this size **because** it inherits the whole
promotion engine from [discounts-and-promotions.md](discounts-and-promotions.md) and reuses the existing
`discountAmountMinor` seam — the only new machinery is the code, its caps, and the redemption bookkeeping.
