---
title: B2B contract pricing
cluster: Pricing & Promotions
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/pricing/domain/price.model.ts
---

# B2B contract pricing

## Description

A **contract price** is a price negotiated with one business account and honoured for the term of an
agreement: Acme pays £4.20 for a widget that lists at £5.00, for the life of their contract, regardless of
what the public price does. It is neither a promotion (no conditions, no marketing window) nor a public
price (it applies to exactly one account or one branch of a company tree). Shopify B2B's price lists per
company, Adobe Commerce B2B's shared catalogs and commercetools' standalone prices per channel all model
this as an account-scoped price rule.

This guide adds **only the pricing attachment**. The business party it scopes against is owned by
[b2b-quote-po-credit-terms.md](../order-management/b2b-quote-po-credit-terms.md) (the `BusinessAccount`, its buyers and terms),
and the account *tree* a contract price can roll down is owned by
[b2b-company-hierarchies.md](../customer-and-identity/b2b-company-hierarchies.md). Where a price gains a non-`(variantId, currency)`
scope axis at all is the mechanism [customer-group-and-tiered-pricing.md](customer-group-and-tiered-pricing.md)
introduces, which this guide reuses; and the reduction machinery, where relevant, is
[discounts-and-promotions.md](discounts-and-promotions.md)'s. This guide inherits all of that and contributes
the one thing none of them do: an **account-scoped, contract-term price on the ledger**.

## Business needs

- **Negotiated pricing is the norm in B2B** — a wholesale relationship is defined by an agreed price
  schedule, not a public list; without it there is no B2B commerce.
- **Contract prices are stable and audited** — unlike a promotion, a contract price has a term and must be
  reconstructable for the life of the agreement: "what was Acme's contracted price on this date" is a
  billing and dispute question the append-only ledger already answers for public prices.
- **Scope rolls down a company tree** — a price negotiated with a parent applies to its subsidiaries unless
  a subsidiary overrides it, which needs the account hierarchy to scope against.
- The threshold: a shop with public pricing only never needs this; the first signed wholesale agreement
  with its own price schedule is where contract pricing has to exist.

## Attachment points in the current core

- **The `Price` ledger at
  `apps/catalog-microservice/src/modules/pricing/domain/price.model.ts`.** A contract price is a `Price`
  with an account-scoped scope — the same `priceScope` axis ADR-026 §2 reserved and
  [customer-group-and-tiered-pricing.md](customer-group-and-tiered-pricing.md) lifts, here keyed to a
  `BusinessAccount` (or a node in its tree) rather than a marketing segment. It stays append-only: a
  renegotiation closes the account's open contract row and appends the successor, so the full contract
  history survives. The ledger's `priority` field lets a contract price override the public row for that
  account.
- **The `BusinessAccount` party**
  ([b2b-quote-po-credit-terms.md](../order-management/b2b-quote-po-credit-terms.md)) — inherited whole. The account, its
  authorised buyers and its terms are defined there; this guide references the account by id to scope a
  price and never re-models the party.
- **The account hierarchy**
  ([b2b-company-hierarchies.md](../customer-and-identity/b2b-company-hierarchies.md)) — the materialized-path tree of accounts
  (the `Category` shape). A contract price scoped to a parent node rolls down to descendants by the same
  `path LIKE '/acme%'` subtree read the hierarchy already uses; a leaf-scoped price overrides it. This guide
  reads that tree to resolve which contract price a given buyer sees, and does not re-model the hierarchy.

## Implementation sketch

- **An account-scoped price row.** Reuse the `priceScope` axis so a `Price` can carry a `businessAccountId`
  (or the tree node it attaches to). The `open_scope_key` backstop widens to include the account, so Acme's
  open contract price and the public open price coexist as distinct scopes, each the single open row for its
  own scope. No new mutation path: `SetPrice`'s close-predecessor-then-append handles a contract change
  exactly as a public one.
- **Resolution prefers the most specific scope.** The price query resolves the buyer → their account →
  their position in the tree, gathers candidate rows (leaf contract, ancestor contract, public), and the
  existing highest-`priority`-then-latest-`validFrom` policy picks — with contract rows carrying higher
  priority than public, and a leaf contract overriding an ancestor's. The tiebreak stays in the use case.
- **Contract terms bound the price's validity.** A contract price's `[validFrom, validTo)` interval is the
  agreement term; expiry falls back to the next-most-specific scope (an ancestor contract, or the public
  price) with no write, because the closed interval simply stops containing "now".
- **Events ride `ris.events`** — a contract price change is `catalog.price.changed` carrying the account
  scope. **No PII** (ADR-037): the payload carries the account id, never the buyers' contact details.
- **Shared types** under `libs/contracts/<cluster>/`; a cached contract-price read names a
  `CACHE_KEYS.catalogPrice` scoped successor, never a literal.

## Open design questions

- **Per-account price rows vs. a named price list shared by many accounts.** A price *list* (one schedule
  assigned to N accounts) scales better for a wholesaler with hundreds of accounts on identical terms; a
  per-account row is simpler but multiplies the ledger. Which one the scope keys on is the core modelling
  call.
- **Roll-down vs. explicit assignment down the tree.** Does a parent contract automatically apply to every
  descendant, or must each node be assigned? Automatic roll-down reuses the subtree read cleanly but makes
  "why did this branch get this price" a tree walk.
- **Contract price vs. contract discount.** A negotiated *percentage off list* tracks the public price as
  it moves; a negotiated *fixed price* does not. Whether a contract is a scoped price row or a scoped
  discount rule decides which, and they behave differently when the list price changes mid-term.
- **Currency of a cross-border contract** — an account transacting in multiple currencies needs a contract
  row per currency, since the ledger scope already includes currency and `Order.currency` is immutable.

## Effort sketch

`2–3 capabilities` — an account-scoped price on the ledger (reusing the `priceScope` axis and the widened
`open_scope_key` backstop), resolution that prefers the most specific scope down the account tree, and the
contract-term validity. It is bounded **because** it inherits the account from
[b2b-quote-po-credit-terms.md](../order-management/b2b-quote-po-credit-terms.md), the tree from
[b2b-company-hierarchies.md](../customer-and-identity/b2b-company-hierarchies.md), and the scope mechanism from
[customer-group-and-tiered-pricing.md](customer-group-and-tiered-pricing.md); its only new surface is the
account-scoped ledger row and its resolution.
