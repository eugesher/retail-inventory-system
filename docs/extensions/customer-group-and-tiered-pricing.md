---
title: Customer-group and tiered pricing
cluster: Pricing & Promotions
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/pricing/domain/price.model.ts
---

# Customer-group and tiered pricing

## Description

**Customer-group pricing** charges different customers different prices for the same variant: wholesale
accounts pay less than retail walk-ins, a "VIP" tier gets member pricing, a trade group sees cost-plus.
**Tiered pricing** is the quantity dimension of the same idea — buy 10 at one price, 100 at a lower one.
Both are price rules **scoped to a group**, and every mature platform has them: Shopify's B2B catalogs,
Adobe Commerce's customer-group prices and tier prices, commercetools' price tiers.

This guide **does not own the grouping** and **does not own the discount engine**. The segment/group
concept is owned by [customer-segments-and-tiers.md](customer-segments-and-tiers.md) — "a tier is a
segment with benefits" is its framing, and this capability is one of those benefits: the *price* a tier
unlocks. Where a conditional reduction is computed and stored is owned by
[discounts-and-promotions.md](discounts-and-promotions.md). What this guide adds is the missing **scope
axis** on pricing: the ability to scope a price rule to a customer group at all, which the core
deliberately does not have yet.

## Business needs

- **Wholesale and trade accounts pay a different price** — B2B and trade selling assume group pricing;
  a single public price list cannot serve both retail and wholesale from one catalogue.
- **Loyalty tiers unlock member pricing** — bronze/silver/gold is a ranked segment whose benefit is a
  price, exactly the "what a tier's benefit points at" open question the segments guide leaves to the
  consuming capability.
- **Quantity breaks** — a price that falls at 10/100/1000 units is standard in B2B and bulk retail; the
  break is a function of cart quantity, evaluated at checkout.
- The threshold: a shop that charges everyone the same never needs this; the first "wholesale sees a
  different price" or "gold members save 10%" is where price has to gain a group scope.

## Attachment points in the current core

- **The `Price` ledger's scope and priority at
  `apps/catalog-microservice/src/modules/pricing/domain/price.model.ts` — and the scope axis it
  deliberately lacks.** ADR-026 §2 fixes the price scope at **exactly `(variantId, currency)`** and
  explicitly rules **customer-group scope out** as an unmet threshold, naming a future `priceScope`
  extension that "lifts the scope axis when a concrete need appears". **This guide is that extension.** It
  is not inventing a seam; it is filling the one ADR-026 reserved by name. The ledger's `priority` field
  already exists to disambiguate overlapping applicable rows, which a group price needs.
- **The `SelectApplicablePrice` policy** (`select-applicable-price.use-case.ts`) — highest `priority`, then
  latest `validFrom`, over the candidate set. A group-scoped price extends the *inputs* to this resolution
  (the query gains a group), not the tiebreak itself; the policy stays where it is, testable in isolation.
- **The `CustomerSegment` grouping** ([customer-segments-and-tiers.md](customer-segments-and-tiers.md)) —
  inherited whole. A "group" here **is** a segment defined there; this guide reads membership to resolve
  which group prices a given customer sees, and never re-models the grouping. A tombstoned customer is
  excluded by the segment's own live-status rule.

## Implementation sketch

- **Lift the price scope from `(variantId, currency)` to `(variantId, currency, groupId?)`.** This is the
  `priceScope` axis ADR-026 anticipated: a group-scoped row is a `Price` whose scope includes a segment id,
  with a null group meaning the public price. Crucially, the **at-most-one-open-row invariant and its
  `open_scope_key` backstop widen with the scope** — the generated column keys on the fuller scope, so a
  public open price and a wholesale open price coexist without colliding, each the single open row *for its
  scope*. This stays append-only: a group price change closes the group's predecessor and appends, exactly
  as today.
- **Tiered (quantity) pricing is a small addition on top** — either a per-tier row set (a price valid for
  a quantity band) or a rule evaluated at cart totalling. Quantity is a cart fact, so a quantity break is
  most naturally resolved at checkout through the promotion engine rather than as extra ledger rows;
  group *identity* is a stable scope and belongs on the ledger.
- **Resolution passes the customer's group.** The price query gains the resolved `groupId`, `findInEffect`
  returns group-scoped candidates alongside public ones, and the existing priority/recency policy picks —
  a group price simply carries higher `priority` than the public row it overrides.
- **Events ride `ris.events`** — a group-scoped price change is still `catalog.price.changed` /
  `catalog.price.scheduled`, now carrying the scope's group id. **No PII** (ADR-037): a group is a segment
  id, never a member roster.
- **Shared types** under `libs/contracts/<cluster>/`; a cached group-price read names the existing
  `CACHE_KEYS.catalogPrice` builder (or a scoped successor), never a key literal.

## Open design questions

- **Group price on the ledger vs. a discount rule.** Modelling wholesale as a *scoped price row* keeps it
  in the audited ledger with full history; modelling it as a *promotion* keeps the ledger single-scoped and
  puts group logic in the engine. Contract and long-lived group prices argue for the ledger; short-lived
  member offers argue for the engine. This is the load-bearing call, and it decides how far the
  `open_scope_key` backstop has to widen.
- **How deep the scope axis goes** — group is the first new axis, but location and channel are the others
  ADR-026 named. Adding them one at a time vs. a general `priceScope` value object is a schema-shape
  decision.
- **Quantity-break resolution** — as ledger rows (auditable, but a row per band) or as a checkout rule
  (flexible, but the break is not in the price history). The two treat "what did this cost at quantity N on
  this date" differently.
- **Overlap between a group price and a group promotion** — if a customer's group both sets a base price
  *and* matches a promotion, the base the engine reduces must be the group price, not the public one.

## Effort sketch

`2–3 capabilities` — widening the price scope to carry a group (with the `open_scope_key` backstop lifted
to match), threading the resolved group through the price query, and the quantity-break resolution. It is
bounded **because** it inherits the grouping from
[customer-segments-and-tiers.md](customer-segments-and-tiers.md) and the reduction machinery from
[discounts-and-promotions.md](discounts-and-promotions.md); the new work is the one scope axis ADR-026
already reserved.
