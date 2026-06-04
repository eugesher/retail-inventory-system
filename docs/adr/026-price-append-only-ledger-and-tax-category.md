# ADR-026: `Price` append-only ledger and the `TaxCategory` label

- **Date**: 2026-06-04
- **Status**: Accepted

---

## Context

The catalog context owns the merchandisable graph — products and the concrete,
sellable `ProductVariant` units a customer buys
([ADR-025](025-catalog-product-and-variant-aggregate.md)). A variant is "the
sellable, stocked, **priced** unit," but until now nothing owned the *price*.
ADR-025 even left a deliberate seam: a published product should arguably require
"≥1 active Price", but there was no Price to check against, so `Product.publish()`
enforced only the variant count and the price precondition was recorded as a
documented placeholder.

The pricing capability now exists as a sibling module **inside** the catalog
microservice (`apps/catalog-microservice/src/modules/pricing/`), colocated with
catalog because a price attaches to a `variantId` and the two are authored by the
same people and change for related reasons — see
[01 — The pricing module scaffold](../implementation/03-pricing-price-and-tax-category/01-pricing-module-scaffold.md).
This decision records the shape of pricing's write/read state: the `Price`
domain model and its append-only-for-history ledger, the at-most-one-open-row
invariant, and the `TaxCategory` classification label. It covers the domain and
persistence layers; the use cases that *resolve* an applicable price, the events,
and the publish hard-fail build on this model and are cross-referenced where they
land.

A core requirement frames the whole design: **every price change must be
auditable.** You must be able to answer "what did this variant cost on this
date, and when did that change?" — not just "what does it cost now."

## Decision

### 1. `Price` is an append-only-for-history, time-bounded ledger row

A `Price` is one row in a ledger, not a mutable cell. Its fields are an opaque
`variantId`, a `currency`, an integer `amountMinor` (minor units — cents), a
`[validFrom, validTo)` half-open interval, and a `priority`. A price is **never
value-edited in place.** A price *change* is modelled as **two operations**: a
new row for the new amount, plus a **close** of the predecessor (setting its
`validTo`). The old row is retained, closed, forever.

This is what satisfies the always-audit rule for free. The closed/open intervals
form a complete history per scope: every amount that was ever in effect, and
exactly the window it applied to, is a row you can read back. There is no
"previous value" to reconstruct because nothing was overwritten.

The model enforces this by construction:

- **Two construction paths.** `Price.set({...})` is the standard write path —
  `validFrom` defaults to "now" and a `validFrom` **strictly before now** is
  rejected (`PRICE_VALID_FROM_IN_PAST`). You set or schedule only open intervals
  at or after now; you never author history through this path.
  `Price.reconstitute({...})` loads a row from persistence with any `validFrom`
  (including the past) and is also how the repository materializes a closed
  predecessor — no "past" guard.
- **`close(at)` is the only permitted mutation.** It returns a *new* `Price`
  carrying the same value fields with `validTo = at`. `amountMinor`, `currency`,
  `variantId`, and `priority` are immutable once constructed — there is **no
  setter** for them. A value change is a new row plus this close, never an edit.
- **Invariants** raise a `PricingDomainException` with a typed code (the
  `CatalogErrorCodeEnum` pattern from ADR-025): `amountMinor` is an integer
  `≥ 0` (`PRICE_AMOUNT_INVALID`); `currency` matches the ISO-4217 *shape*
  `^[A-Z]{3}$` only — no rate or registry lookup (`PRICE_CURRENCY_INVALID`);
  when `validTo` is set, `validFrom < validTo` (`PRICE_INTERVAL_INVALID`);
  `priority` is an integer, default `0` (`PRICE_PRIORITY_INVALID`).

### 2. The only scope axis is `(variantId, currency)`

A price is scoped by exactly two things: which variant, and which currency. That
is the entire scope surface this capability has. Location, sales channel, and
customer-group pricing are real things a mature pricing engine has — and they are
**explicitly out** here. They are unmet thresholds: the system has no
multi-location, multi-channel, or customer-tier concept to scope against yet, so
adding the columns now would be speculative machinery. A future `priceScope`
extension lifts the scope axis when a concrete need appears; until then the
narrow `(variantId, currency)` scope is the whole story, and the at-most-one-open
invariant (below) is defined over it.

### 3. At most one open row per scope — app primary, DB backstop

An **open** row is one with `validTo IS NULL` — the price currently in effect
with no scheduled end. The invariant is: **at most one open row per
`(variantId, currency)`.** Two open rows would mean "the current price is
ambiguous," which the resolution step must never face.

It is enforced in two layers:

- **Primary mechanism — app-level close-in-transaction.** The repository's
  `appendPrice(newPrice, predecessorToClose)` runs the close-of-predecessor
  `UPDATE` and the insert of the successor inside **one** TypeORM transaction
  (`manager.transaction(...)`), then re-reads the inserted row so its assigned id
  comes back concrete (the "re-read the saved graph" idiom
  `CatalogTypeormRepository.save` uses). There is never a committed window with
  two open rows.
- **Backstop — a generated-column UNIQUE index.** MySQL has **no native partial
  unique index** (Postgres's `UNIQUE ... WHERE valid_to IS NULL`). It is emulated
  with a `STORED` generated column `open_scope_key` that is non-NULL **only while
  `valid_to IS NULL`** (`CASE WHEN valid_to IS NULL THEN CONCAT(variant_id, ':',
  currency) ELSE NULL END`), under a plain `UNIQUE` index. MySQL permits many
  NULLs under a UNIQUE index, so closed rows (NULL key) never collide, while two
  open rows for one scope produce the same key and the second insert fails with a
  duplicate-key error. The column is **not** mapped on the entity — it is a
  DB-internal backstop; with `synchronize` off TypeORM never touches it, and an
  insert that omits it lets MySQL compute it.

The app-level transaction is what keeps the common path clean; the backstop is
what a concurrency test exercises and what would catch a racing double-append.

### 4. Select Applicable resolution — coarse query here, policy in the use case

Reading "the price in effect for this variant/currency at time *T*" is split:

- **The repository supplies the candidate set.** `findInEffect(variantId,
  currency, asOf)` returns **all** rows whose `[validFrom, validTo)` interval
  contains `asOf` — a coarse filter (`valid_from <= asOf AND (valid_to IS NULL OR
  valid_to > asOf)`), backed by the `IDX_PRICE_RESOLVE (variant_id, currency,
  valid_from DESC)` index.
- **The use case picks the winner.** The Select Applicable *policy* is **highest
  `priority`, then latest `validFrom`** over that candidate set. Putting the
  tiebreak in the use case (not in SQL `LIMIT 1`) keeps the rule testable in
  isolation and lets it evolve without a schema change. The algorithm itself is
  realized by the price-resolution use case that builds on this model; this ADR
  fixes the policy, the use case implements it.

Because the at-most-one-open invariant holds, the only way the candidate set has
more than one row is overlapping **scheduled** (future-dated, since-arrived)
intervals — exactly what `priority` then `validFrom` disambiguate.

### 5. `variantId` is an opaque link — no catalog import

The pricing domain **never imports the catalog `Product`/`ProductVariant`.** A
`Price` references its variant by a bare `variantId: number`. The only coupling
between pricing and catalog persistence is the `FK_PRICE_VARIANT` foreign key
(`price.variant_id → product_variant.id`, `ON DELETE RESTRICT`) in the migration.
This is the same module-isolation the boundaries lint
([ADR-017](017-architecture-lint-via-eslint-boundaries.md)) enforces across a
service boundary, applied to two modules in one process: pricing addresses the
variant by an opaque id and reaches nothing inside catalog's domain.

### 6. `TaxCategory` is a classification label only

`TaxCategory` is a stable `code` (UPPER_SNAKE_CASE, `^[A-Z][A-Z0-9_]*$`,
`TAX_CATEGORY_CODE_INVALID`) plus a human `name` (non-empty,
`TAX_CATEGORY_NAME_REQUIRED`) and an optional `description`. It carries **no
rate, no jurisdiction, no conversion logic.** Computing tax — rates, regional
rules, rounding — is a separate future capability; modelling a half-rate here
would be the same mistake as fabricating a price scope nobody can fill yet. A
variant points at one tax category through the **nullable**
`product_variant.tax_category_id` FK (`ON DELETE SET NULL` — removing a category
orphans its variants to "unclassified" rather than blocking the delete). The
attach use case and endpoint land with the pricing application work; the column
and the table exist now.

Global `TaxCategory.code` uniqueness is a **repository-level** invariant (the
`UC_TAX_CATEGORY_CODE` UNIQUE constraint + a use-case pre-check), not enforced in
the model — the same `slug`/`sku` convention catalog uses (ADR-025): the domain
cannot see other rows, so it trusts the repository to reject a clash with a typed
`TAX_CATEGORY_CODE_TAKEN`.

### 7. A second concrete `DomainException` consumer

`PricingDomainException` + `PricingErrorCodeEnum` mirror
`CatalogDomainException` (ADR-025 §8): one throwable per bounded context,
carrying a stable, greppable typed `code` the presentation layer maps to an HTTP
status — never a string-matched message. The codes seeded here are the Price and
TaxCategory invariants plus the repository-level rejections the write use cases
raise (`TAX_CATEGORY_CODE_TAKEN`, `TAX_CATEGORY_NOT_FOUND`, `VARIANT_NOT_FOUND`).

## Alternatives considered

1. **An in-place mutable price (one row per variant/currency, edited on change).**
   Rejected. It loses the audit trail and the history outright — the central
   requirement. You could not answer "what did this cost last month," and an
   `updated_at` only tells you *that* it changed, not *to and from what* or
   *across which window*. The append-only ledger makes history a first-class,
   queryable artifact.
2. **Location / channel / customer-group scope now.** Rejected — unmet threshold.
   There is no multi-location, multi-channel, or customer-tier concept to scope
   against, so the columns would be speculative. A future `priceScope` extension
   lifts the axis when a real need exists; `(variantId, currency)` is the whole
   scope today.
3. **A separate pricing microservice.** Rejected. A price attaches to a
   `variantId`; pricing reads the same merchandisable graph catalog owns and is
   authored by the same people. A separate deployable would put a RabbitMQ hop
   between "this variant exists" and "this variant costs X" for no isolation
   benefit. Pricing colocates with catalog and shares `catalog_queue`; the
   module-isolation lint holds the domain boundary without a process boundary
   (see [01 — The pricing module scaffold](../implementation/03-pricing-price-and-tax-category/01-pricing-module-scaffold.md)).
4. **A native partial unique index for the open-row invariant.** Not available —
   MySQL has none. The `STORED` generated-column-plus-UNIQUE pattern emulates it;
   a `CHECK`-and-trigger approach was heavier and harder to reason about.
5. **`SELECT ... LIMIT 1` for Select Applicable.** Rejected as the home of the
   policy. The priority/recency tiebreak is business logic that should be unit
   testable and free to evolve; the repository supplies the interval-containing
   candidates and the use case applies the policy.

## Consequences

- The pricing domain layer exists and is framework-free
  (`apps/catalog-microservice/src/modules/pricing/domain/`), with spec siblings
  covering the append-only invariant, the interval and amount/currency rules, and
  the `close` mutation. The boundaries lint confirms it imports only
  `libs/{ddd,common,contracts}` and never reaches into catalog.
- Three new schema objects exist in the shared `retail_db`: the `price` table
  (with the `open_scope_key` backstop and the `IDX_PRICE_RESOLVE` index), the
  `tax_category` table, and the nullable `product_variant.tax_category_id` FK
  column. The migration applies and reverts cleanly on top of the catalog schema.
- **The publish "≥1 active Price" precondition now has a `Price` to check
  against.** ADR-025's documented seam can be wired into the publish flow as a
  hard fail by the pricing application work; that enforcement is recorded with
  the use cases that own it, not here.
- `TaxCategory` is available as a classification label; a future tax-computation
  capability adds rates and jurisdictions without reshaping this label set.
- `PricingDomainException` is the second concrete `DomainException` consumer; the
  typed-error pattern continues to spread without re-fitting older aggregates.

## References

- [ADR-025](025-catalog-product-and-variant-aggregate.md) — the catalog
  aggregate that defines `variantId` as the downstream backbone key pricing keys
  on, the `DomainException` + typed-code pattern this mirrors, and the
  repository-level-uniqueness convention; its §6 publish-price seam is the
  precondition this capability now enables.
- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) /
  [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the per-module
  hexagonal layout and the forbidden-import rule that make `variantId` an opaque
  link (no catalog import from pricing).
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — `BaseEntity`,
  `SnakeNamingStrategy`, the hand-authored-migration workflow, and the
  `synchronize`-off rule the `price` / `tax_category` tables follow.
- [01 — The pricing module scaffold](../implementation/03-pricing-price-and-tax-category/01-pricing-module-scaffold.md)
  — why pricing is a sibling module sharing `catalog_queue`, not a fifth
  deployable.
- [02 — The `Price` domain and the append-only history](../implementation/03-pricing-price-and-tax-category/02-price-domain-and-append-only-history.md)
  — the implementation companion to this decision.
- [03 — `TaxCategory` and variant attachment](../implementation/03-pricing-price-and-tax-category/03-tax-category-and-variant-attachment.md)
  — the tax-category label and the variant FK (the attach use case completes it).
