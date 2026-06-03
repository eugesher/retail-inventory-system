---
epic: epic-03
task_number: 5
title: Publish Product hard-fails on a missing active Price
depends_on: [1, 2, 3, 4]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/04-publish-precondition-hard-fail.md
adr_deliverable: none
---

# Task 05 — Publish Product hard-fails on a missing active Price

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-025** (the publish "≥1 active Price" precondition was a
documented *seam* — enforcement belongs in the publish **use case**, not the
domain; `CatalogDomainException` + a typed code mapped to HTTP by the filter),
**ADR-017** (the catalog module may **not** import the pricing module — the probe
reads the `price` table via a parameterized query, the symmetric mirror of how
pricing writes `product_variant`), and **ADR-019** (config via the Joi schema in
`libs/config`).

## Goal

Turn the previously-deferred "a product must have ≥1 active Price before it can
be published" precondition into a hard rule. The catalog `PublishProductUseCase`
now rejects publishing any product where **any** variant lacks an in-effect Price
in the configured `DEFAULT_CURRENCY` (default `USD`), returning HTTP **409
Conflict** ("preconditions not met to publish"). The domain still owns only the
≥1-variant rule; the price precondition is enforced in the use case via a
catalog-side probe port.

## Entry state assumed

- task-01 → task-04 carryover present. task-01 already **removed** the
  warn-and-proceed placeholder from `PublishProductUseCase` and its
  `'warns…'` spec test, so the use case currently enforces only the domain
  ≥1-variant rule with no price awareness.
- Select Applicable Price + the `price` table + the `findInEffect` semantics
  exist (task-02/03). The `price` table is queryable by `(variant_id, currency)`
  with the resolve index `IDX_PRICE_RESOLVE`.
- `CatalogErrorCodeEnum` + `CatalogRpcExceptionFilter` map typed codes →
  HTTP status (not-found → 404, taken/illegal-state → 409, bad input → 400).
- The gateway publish route `POST /api/catalog/products/:productId/publish`
  already surfaces the wire error's `statusCode` — no gateway change is needed
  for the 409 to propagate.

## Scope

**In**
- A catalog-side probe port `IActivePriceProbePort` (+ `ACTIVE_PRICE_PROBE`
  symbol) + its TypeORM adapter that reads the `price` table via a parameterized
  query (no pricing import).
- `PublishProductUseCase` enforces the price precondition; add
  `PRODUCT_PUBLISH_REQUIRES_PRICE` to `CatalogErrorCodeEnum` and map it to **409**
  in `CatalogRpcExceptionFilter`.
- `DEFAULT_CURRENCY` env (Joi schema in `libs/config`, default `USD`), threaded to
  the use case via a `CATALOG_DEFAULT_CURRENCY` string token.
- Update `publish-product.use-case.spec.ts` to assert the hard-fail.
- Doc `04-publish-precondition-hard-fail.md`; finalize the CLAUDE.md publish line
  and the epic-02 publish-precondition doc passages.

**Out**
- Gateway controller changes (the route exists; only the status code it now
  surfaces changes). The e2e proof of the 409 lives in task-06.
- Seeded prices (task-08) — this task's unit spec uses a probe double; the e2e
  (task-06) creates its own draft product with no price to drive the 409.

## Probe port + adapter (parameterized — no pricing import)

In `apps/catalog-microservice/src/modules/catalog/application/ports/`:

```ts
export const ACTIVE_PRICE_PROBE = Symbol('ACTIVE_PRICE_PROBE');

export interface IActivePriceProbePort {
  // Of the given variant ids, which have NO in-effect Price in `currency` at now?
  // An empty result means every variant is priced — publish may proceed.
  findVariantsMissingActivePrice(variantIds: number[], currency: string): Promise<number[]>;
}
```

Implement in `apps/catalog-microservice/.../catalog/infrastructure/persistence/active-price-probe.typeorm.adapter.ts`
with a parameterized query against `price` — e.g. for each (or batched):
`SELECT variant_id FROM price WHERE variant_id IN (?) AND currency = ?
AND valid_from <= UTC_TIMESTAMP() AND (valid_to IS NULL OR valid_to > UTC_TIMESTAMP())`,
then diff against the requested ids. **Do not** import any pricing entity/model
(cross-module infrastructure import — forbidden by the boundaries lint); the
`price` table + the opaque `variantId` are the only coupling, the mirror of how
pricing writes `product_variant.tax_category_id` (ADR-017/ADR-025).

## `PublishProductUseCase` change

After loading the product (and confirming it exists), before `product.publish()`:
1. Collect the product's variant ids.
2. `const missing = await probe.findVariantsMissingActivePrice(variantIds,
   defaultCurrency)`.
3. If `missing.length > 0`, throw `new CatalogDomainException(
   CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_PRICE, 'Cannot publish #<id>:
   variant(s) <ids> have no active <currency> price')`.
4. Otherwise proceed exactly as today (`product.publish()`, persist, drain the
   `ProductPublishedEvent`, best-effort emit `catalog.product.published`).

Inject `defaultCurrency` via `@Inject(CATALOG_DEFAULT_CURRENCY)` (a plain string)
so the use case stays free of `@nestjs/config`. Bind the token in
`catalog.module.ts`:
`{ provide: CATALOG_DEFAULT_CURRENCY, useFactory: (config: ConfigService) =>
config.get<string>('DEFAULT_CURRENCY') ?? 'USD', inject: [ConfigService] }`.

## Config

`libs/config` Joi schema — add `DEFAULT_CURRENCY: Joi.string().length(3).uppercase().default('USD')`.
Because it is `.default('USD')` the boot does not fail when the var is absent; add
it to `.env` / `.env.local` examples and `docker-compose.yml` for the catalog
service so the documented value is explicit (README env entry lands in task-08).

## Filter mapping

`CatalogRpcExceptionFilter` — map `PRODUCT_PUBLISH_REQUIRES_PRICE → 409`
(it joins the existing illegal-state/conflict → 409 group). Extend the filter
spec to cover the new code.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/application/ports/active-price-probe.port.ts`
- `apps/catalog-microservice/.../catalog/infrastructure/persistence/active-price-probe.typeorm.adapter.ts`
- `docs/implementation/03-pricing-price-and-tax-category/04-publish-precondition-hard-fail.md`

## Files to modify

- `apps/catalog-microservice/.../catalog/application/use-cases/publish-product.use-case.ts`
  — inject `ACTIVE_PRICE_PROBE` + `CATALOG_DEFAULT_CURRENCY`; enforce the
  precondition.
- `.../catalog/application/use-cases/spec/publish-product.use-case.spec.ts` —
  add the hard-fail tests (probe double).
- `apps/catalog-microservice/.../catalog/domain/catalog.exception.ts` — add
  `PRODUCT_PUBLISH_REQUIRES_PRICE`.
- `.../catalog/presentation/catalog-rpc-exception.filter.ts` (+ its spec) — map
  the new code to 409.
- `apps/catalog-microservice/.../catalog/application/ports/index.ts`,
  `infrastructure/persistence/index.ts` — barrels.
- `apps/catalog-microservice/.../catalog/catalog.module.ts` — provide the probe
  adapter (`ACTIVE_PRICE_PROBE`) and the `CATALOG_DEFAULT_CURRENCY` token; ensure
  `ConfigModule`/`ConfigService` is available (it is global via `app.module.ts`).
- `libs/config/*` — add `DEFAULT_CURRENCY` to the Joi schema.
- `docker-compose.yml`, `.env` / `.env.local` examples — add `DEFAULT_CURRENCY=USD`
  for the catalog service.
- `CLAUDE.md` — update the `catalog.product.publish` line to state the hard 409 on
  a missing active Price in `DEFAULT_CURRENCY`.
- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md`
  (and `03-product-and-variant-domain.md` if it still hints "deferred") — finalize:
  the precondition is now enforced as a hard 409 by the publish use case via the
  active-price probe.

## Files to delete

None (task-01 already removed the placeholder).

## Tests

- **Unit** (`yarn test:unit`) — `publish-product.use-case.spec.ts`, with an
  in-memory `IActivePriceProbePort` double:
  - rejects publishing when a variant lacks an active price
    (`PRODUCT_PUBLISH_REQUIRES_PRICE`); nothing is persisted; no event emitted.
  - publishes + emits when the probe reports every variant priced.
  - the existing no-variant (`PRODUCT_PUBLISH_REQUIRES_VARIANT`) and not-found
    cases stay green; the ≥1-variant check should run before/independently of the
    price probe (a no-variant product still fails on the variant rule).
- **Filter spec** — `PRODUCT_PUBLISH_REQUIRES_PRICE → 409`.
- `yarn test:e2e` still passes (the seed inserts products as `active` directly via
  SQL, bypassing publish, so the hard-fail does not break the existing catalog
  e2e). The publish-no-price 409 e2e is added in task-06.

## Doc deliverable

`04-publish-precondition-hard-fail.md` — what changed from the prior warn path
(removed in the cleanup) to the hard rule; **why 409 Conflict** (the request is
well-formed but the resource state — no active price — forbids the transition;
contrast with 422); the catalog-side probe port + why it reads the `price` table
via a parameterized query rather than importing the pricing module
(`variantId`-as-opaque-link boundary); the `DEFAULT_CURRENCY` knob and its default.

## Carryover to read

`carryover-01.md` … `carryover-04.md`.

## Carryover to produce

Write `carryover-05.md`. Capture: the `IActivePriceProbePort` + `ACTIVE_PRICE_PROBE`
+ the adapter's parameterized query; `PRODUCT_PUBLISH_REQUIRES_PRICE` + its 409
mapping; the `CATALOG_DEFAULT_CURRENCY` token + the `DEFAULT_CURRENCY` Joi default;
that publish now hard-fails. Note the gaps (gateway e2e proof + concurrency test →
task-06; the README env entry → task-08). Verify commands.

## Exit criteria

- [ ] `PublishProductUseCase` rejects a product with any unpriced variant
      (`PRODUCT_PUBLISH_REQUIRES_PRICE` → 409); the domain still owns only the
      ≥1-variant rule.
- [ ] The probe reads the `price` table via a parameterized query; the catalog
      module imports nothing from the pricing module (`yarn lint` clean).
- [ ] `DEFAULT_CURRENCY` is in the Joi schema (default `USD`) and reaches the use
      case via `CATALOG_DEFAULT_CURRENCY`.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the updated publish spec + filter spec are green.
- [ ] `yarn test:e2e` passes.
- [ ] `04-publish-precondition-hard-fail.md` is written; the CLAUDE.md publish
      line + the epic-02 doc passages reflect the hard fail.
- [ ] The self-containment grep is clean.
- [ ] `carryover-05.md` is written.
