# 04 — Publishing a product hard-fails on a missing active Price

This document records the precondition that turns a draft product into an active,
browsable one: **every variant must have an in-effect Price in the default
currency before the product can be published.** What used to be a soft "warn and
proceed" placeholder is now a hard rule — the catalog `PublishProductUseCase`
rejects the publish with **HTTP 409 Conflict** when any variant is unpriced.

It builds on the price ledger and its resolution semantics in
[02 — The `Price` domain and the append-only history](02-price-domain-and-append-only-history.md)
and [05 — Set / Schedule / Select Applicable Price](05-select-applicable-price.md),
and it closes the seam the catalog aggregate left open in
[02-catalog · 05 — Catalog use cases](../02-catalog-product-and-variant/05-catalog-use-cases.md).
It is governed by [ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)
(the precondition is a *use-case* rule, not a domain rule; typed
`CatalogErrorCodeEnum` → HTTP via the filter), [ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md)
(the `price` ledger this probes), [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)
(the catalog module may **not** import the pricing module — the probe reads the
`price` table by parameterized query), and
[ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md) (the
`DEFAULT_CURRENCY` knob comes through the `libs/config` Joi schema).

The code lives under `apps/catalog-microservice/src/modules/catalog/`.

## 1. From "warn and proceed" to a hard rule

Before the pricing capability existed, the catalog had a documented placeholder:
`PublishProductUseCase` would *warn* that the "≥1 active Price" precondition was
deferred, then publish anyway. That placeholder was removed when the pricing
module was scaffolded, leaving the use case price-unaware — it enforced only the
domain's ≥1-variant rule.

This change makes the precondition real. A product is publishable only when, for
**every** one of its variants, a Price is in effect in the configured default
currency at the moment of publishing. If any variant is unpriced, the publish is
rejected and nothing changes — the product stays `draft`, no
`catalog.product.published` event is emitted.

Why now a *hard* rule rather than a warning? An active product is the one
customers can browse and (later) order. Activating a product whose variants have
no price would expose an un-orderable, un-quotable row to the storefront. The
price is part of what "ready to sell" *means*, so the precondition belongs on the
write path that flips the switch, not in a log line a human might miss.

## 2. Why 409 Conflict (not 400, not 422)

The publish request itself is perfectly well-formed: a valid `productId`, a
caller with `catalog:publish`. Nothing about the *input* is wrong — so this is
not a `400 Bad Request`. What blocks the transition is the **state of the
resource**: this product, right now, has a variant with no active price, so it
cannot move `draft → active`. That is the textbook meaning of **409 Conflict** —
the request conflicts with the current state of the target resource.

This is the same status, and the same reasoning, the catalog already uses for its
other publish conflict (`PRODUCT_PUBLISH_REQUIRES_VARIANT`, a draft with zero
variants) and for illegal lifecycle transitions
(`PRODUCT_INVALID_STATE_TRANSITION`, e.g. publishing an archived product). A
missing price joins that family.

The plausible alternative is `422 Unprocessable Entity` — "I understood the
request but can't process it." The project's convention, established for the
catalog in ADR-025, is to reserve 4xx-with-a-body for two buckets: **400** for
malformed input (the gateway DTOs catch most of these first) and **409** for
"well-formed but conflicts with resource state." A missing-price publish is
squarely a state conflict, so it reuses 409 and keeps the catalog's error
vocabulary small and consistent rather than introducing a third status for one
case.

The new typed code is `CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_PRICE`
(`CATALOG_PRODUCT_PUBLISH_REQUIRES_PRICE` on the wire). The presentation-layer
`CatalogRpcExceptionFilter` maps it to `409` — it joins the existing
illegal-state / conflict group. HTTP status is a transport concern, so that table
lives in `presentation/`, never in the transport-free domain.

## 3. The probe port — reading `price` without importing pricing

The precondition needs a fact only the pricing data holds: "does this variant
have an in-effect price?" But the catalog module **must not import the pricing
module** — a cross-module infrastructure import is the boundaries lint's red line
(ADR-017). The two modules are colocated in one microservice, but they stay
decoupled at the code level: the only thing they share is the `price` table and
the opaque `variantId`.

So the catalog defines its own thin seam, an **application port**:

```ts
export const ACTIVE_PRICE_PROBE = Symbol('ACTIVE_PRICE_PROBE');

export interface IActivePriceProbePort {
  // Of the given variant ids, which have NO in-effect Price in `currency` at now?
  findVariantsMissingActivePrice(variantIds: number[], currency: string): Promise<number[]>;
}
```

The use case asks the port a question phrased in its own terms ("which of *my*
variants are unpriced?") and never learns that the answer comes from a `price`
table. The port returns plain numbers — no pricing domain type, no TypeORM type
leaks across the seam (ADR-017).

The TypeORM adapter (`ActivePriceProbeTypeormAdapter`, under
`infrastructure/persistence/`) answers it with a single **parameterized** read:

```sql
SELECT DISTINCT variant_id AS variantId
  FROM price
 WHERE variant_id IN (?, ?, …)
   AND currency = ?
   AND valid_from <= UTC_TIMESTAMP()
   AND (valid_to IS NULL OR valid_to > UTC_TIMESTAMP())
```

then diffs the requested ids against the priced set — what remains is the
unpriced set. Key properties:

- **No pricing import.** The adapter injects the catalog `ProductVariantEntity`
  repository purely for its shared `EntityManager`; the query targets the `price`
  table by raw SQL. It imports nothing from `modules/pricing`. This is the exact
  **symmetric mirror** of how the pricing module writes the catalog-owned
  `product_variant.tax_category_id` — pricing reaches a catalog table by
  parameterized query, catalog reaches a pricing table the same way (ADR-026 §5).
  The `variantId`-as-opaque-link is the whole coupling.
- **Parameterized, always.** The `?` placeholder list is built from the array
  *length*, never the values, so every id and the currency are driver-bound
  parameters — never string-concatenated into the SQL.
- **The interval test matches the ledger's.** `valid_from <= now AND (valid_to IS
  NULL OR valid_to > now)` is the same half-open `[validFrom, validTo)`
  containment the pricing repository's `findInEffect` uses (ADR-026). A price is
  "in effect" when it has started and not yet closed.
- **`UTC_TIMESTAMP()` is the clock.** "Now" is evaluated in the database, so the
  probe needs no injected time and no extra round-trip.

## 4. Where the check sits in the publish flow

`PublishProductUseCase.execute(payload)` now runs, in order:

1. **Load** the product; a missing product → `PRODUCT_NOT_FOUND` (404). This
   short-circuits before the probe is reached.
2. **Probe.** Collect the product's concrete variant ids and call
   `probe.findVariantsMissingActivePrice(variantIds, defaultCurrency)`. If the
   result is non-empty → throw `PRODUCT_PUBLISH_REQUIRES_PRICE` (409). Nothing is
   persisted; no event is emitted.
3. **Transition.** `product.publish()` — the domain enforces the two
   preconditions it can see (draft status, ≥1 variant) and records the
   `ProductPublishedEvent`.
4. **Persist**, then drain the event and emit `catalog.product.published`
   (best-effort post-commit; a broker failure is warn-logged and swallowed).

The two precondition layers stay **independent and correctly ordered**. A
variant-less product produces an *empty* id list, so the probe is a no-op
(returns `[]`, and short-circuits before touching the DB) — the ≥1-variant rule
is then what fails, inside `product.publish()`, with
`PRODUCT_PUBLISH_REQUIRES_VARIANT`. The price probe never masks the variant rule;
the domain still owns the only precondition it can actually see.

This division is the ADR-025 §6 principle made concrete: "≥1 active Price" is a
**cross-aggregate fact** the `Product` aggregate cannot observe (it cannot see
other aggregates, let alone another module's table), so it is enforced in the
*use case*, never in the domain. The `Product` model keeps only its variant-count
guard.

## 5. The `DEFAULT_CURRENCY` knob

Which currency must a variant be priced in to publish? The configured default,
`DEFAULT_CURRENCY` — an ISO-4217 three-letter code, defaulting to `USD`. It is
declared in the `libs/config` Joi schema:

```ts
DEFAULT_CURRENCY: Joi.string().length(3).uppercase().default('USD'),
```

Because it carries a default, a missing env var never fails boot; the
`docker-compose.yml` catalog service and the `.env.example` template set it
explicitly so the live value is greppable.

The use case must not depend on `@nestjs/config` (ADR-017 keeps the application
layer framework-light), so the value is threaded in as a plain string under the
`CATALOG_DEFAULT_CURRENCY` DI token. `catalog.module.ts` binds it with a factory
that reads `ConfigService` once (`ConfigModule` is global), and the use case
injects the string with `@Inject(CATALOG_DEFAULT_CURRENCY)`. Swapping the
publish currency is one env change with no code edit.

Today the precondition resolves a *single* currency. A multi-currency catalogue
("publishable when priced in any of these currencies", or "in all of these")
would generalize the probe's `currency` argument, but that is a deliberate
non-goal here — one default currency is the rule.

## 6. Tests

- **Unit — `publish-product.use-case.spec.ts`** (with an in-memory
  `IActivePriceProbePort` double whose `unpriced` set names the variants reported
  missing):
  - rejects the publish with `PRODUCT_PUBLISH_REQUIRES_PRICE` when a variant is
    unpriced — nothing persisted, no event emitted;
  - publishes and emits `catalog.product.published` when every variant is priced,
    and the probe is consulted with the product's variant ids and the default
    currency;
  - the no-variant case still fails on `PRODUCT_PUBLISH_REQUIRES_VARIANT` (the
    probe is a no-op on the empty list), and the not-found case still
    short-circuits before the probe runs.
- **Unit — `active-price-probe.typeorm.adapter.spec.ts`**: the SQL is
  parameterized (placeholders + a bound args array, never interpolated ids), the
  empty-input short-circuit skips the query entirely, the mysql2 string-BIGINT
  coercion holds, and the requested ids diff correctly against the priced set.
- **Unit — `catalog-rpc-exception.filter.spec.ts`**:
  `PRODUCT_PUBLISH_REQUIRES_PRICE → 409`, and the exhaustive "no code falls
  through to 500" check covers the new member.
- **E2E — `test/catalog.e2e-spec.ts`**: the live register → variant → publish
  flow now seeds an open USD price per variant (directly via SQL, the only
  price-write path until the gateway pricing routes land) before publishing, so
  the precondition is met and the happy path stays green. The negative
  publish-with-no-price 409 is proven end-to-end through the gateway in a later
  step, once the pricing HTTP surface exists.

## 7. What this leaves for later

- The gateway already surfaces the wire error's `statusCode`, so the 409
  propagates over HTTP with no gateway change. The **end-to-end proof** of the
  publish-with-no-price 409 (and a concurrency check) lives with the gateway
  pricing endpoints work.
- The `README` environment-variable table gains its `DEFAULT_CURRENCY` row with
  the broader seed/finalization pass.
