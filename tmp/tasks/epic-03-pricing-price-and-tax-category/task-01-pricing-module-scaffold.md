---
epic: epic-03
task_number: 1
title: Scaffold the pricing sibling module inside catalog-microservice (per-module hexagonal skeleton, boundaries lint update, new routing keys, cache-key builder)
depends_on: []
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/01-pricing-module-scaffold.md
---

# Task 01 — Scaffold the `pricing/` sibling module inside `catalog-microservice`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Add a second per-module hexagonal tree — `apps/catalog-microservice/src/modules/pricing/` — beside the existing `catalog/` module from epic-02. After this task the new module loads (an empty `PricingModule` is wired into `app.module.ts`), is governed by the same `eslint-plugin-boundaries` rules as `catalog/`, exposes its placeholder shape (`domain/`, `application/`, `infrastructure/`, `presentation/`) to the file-system linter, registers two new routing keys (`catalog.price.changed`, `catalog.price.scheduled`) up front so task-03's event publisher has somewhere to cite from, and registers a cache-key builder for the future `ris:catalog:price:v1:<variantId>:<currency>` shape. **No Price or TaxCategory code exists yet** — those land in task-02.

This task is foundation-only. There are no entity files, no use cases, no controllers, no migrations. Every later task in this epic assumes the scaffold put in place here.

## Entry state assumed

Epic-02 is complete on disk. Specifically:

- `apps/catalog-microservice/src/modules/catalog/` exists as a per-module hexagonal tree (`domain/`, `application/`, `infrastructure/`, `presentation/`); it owns the `Product` + `ProductVariant` aggregates and the catalog write+read use cases.
- `apps/catalog-microservice/src/app/app.module.ts` imports the catalog `CatalogModule` (from `modules/catalog/infrastructure/catalog.module.ts`).
- `libs/messaging/routing-keys.constants.ts` already lists `catalog.product.created`, `catalog.product.published`, `catalog.product.archived`, `catalog.variant.created` under the `catalog.*` namespace (added by epic-02 task-03).
- `libs/cache/cache-keys.ts` exports `CACHE_KEYS` with the existing `inventoryStock*` and `retailOrder*` builders, but no `catalogPrice*` builder.
- `eslint.config.mjs` carries a `boundaries/element-types` config that captures `apps/*/src/modules/*/{domain,application,infrastructure,presentation}/**`. The pattern uses `*` for the module name; no allowlist of module names exists. A second module under the same app should therefore be governed automatically — verify under §"`eslint.config.mjs`" below.
- `spec/architecture-lint.spec.ts` has a `describe('catalog-microservice fixtures', ...)` block added by epic-02 task-01.

## Scope

**In:**

- A new `apps/catalog-microservice/src/modules/pricing/` tree mirroring the per-module hexagonal shape of `modules/catalog/`. Subdirs: `domain/`, `application/`, `infrastructure/`, `presentation/`. Each subdir is created with a `.gitkeep` and an `index.ts` empty barrel so the boundaries lint sees the element type.
- A bare-bones `modules/pricing/infrastructure/pricing.module.ts` Nest module that imports `TypeOrmModule.forFeature([])` (empty — task-02 fills the entities) so `AppModule` can `imports: [PricingModule]` without runtime error.
- Register two new routing keys in `libs/messaging/routing-keys.constants.ts`:
  - `CATALOG_PRICE_CHANGED: 'catalog.price.changed'`
  - `CATALOG_PRICE_SCHEDULED: 'catalog.price.scheduled'`
- Register the cache-key builder family in `libs/cache/cache-keys.ts`:
  - A new per-aggregate version constant `CATALOG_PRICE_KEY_VERSION = 'v1'`.
  - A `catalogPricePrefix(variantId, opts?)` builder returning `ris:[t:<tenantId>:]catalog:price:v1:<variantId>:`.
  - A `catalogPrice(variantId, currency, opts?)` builder returning `…<variantId>:<currency>`.
  - **No** invalidate-only legacy prefix — this is a fresh key family.
- Update `apps/catalog-microservice/src/app/app.module.ts` to import the new `PricingModule` placeholder.
- Verify `eslint.config.mjs` automatically governs the new `pricing/` tree (the pattern `apps/*/src/modules/*/...` should already match). If a defensive allowlist exists, extend it.
- Extend `spec/architecture-lint.spec.ts` with a new fixture block `describe('catalog-microservice pricing module boundaries', ...)` mirroring the existing `catalog/` fixture block. The fixtures must run at least one positive test (allowed import) and one negative test (forbidden import) per element type.
- Doc deliverable `01-pricing-module-scaffold.md` under `docs/implementation/03-pricing-price-and-tax-category/`.

**Out:**

- The `Price` and `TaxCategory` domain models, entities, mappers, migration — task-02.
- The Set/Schedule/Select use cases + RPC patterns + event payloads — task-03.
- The api-gateway endpoints — task-05.
- The Kulala http file — task-06.
- Seed data — task-07.
- Wiring `Publish Product` to call into `SelectApplicablePriceUseCase` — task-04 (and the cross-module port discipline is documented there).
- A cache-aside read path on `Select Applicable Price` — explicitly NOT wired in this epic (the epic's "Architectural Decisions Honored" section notes the read-volume threshold is unmet). The cache-key builder is added here only so the future wire-up has a registered key.

## Layout to create

Mirror the existing `modules/catalog/` shape line-for-line. End state after this task:

```
apps/catalog-microservice/src/modules/pricing/
├── index.ts                        # empty barrel for task-02 to extend
├── domain/
│   ├── .gitkeep
│   └── index.ts                    # empty barrel
├── application/
│   ├── .gitkeep
│   ├── ports/
│   │   ├── .gitkeep
│   │   └── index.ts                # empty barrel
│   └── use-cases/
│       ├── .gitkeep
│       └── index.ts                # empty barrel
├── infrastructure/
│   ├── pricing.module.ts           # the NestJS @Module() — imports TypeOrmModule.forFeature([]); exports nothing yet
│   ├── persistence/
│   │   ├── .gitkeep
│   │   └── index.ts
│   ├── messaging/
│   │   ├── .gitkeep
│   │   └── index.ts
│   └── index.ts                    # re-exports the module
└── presentation/
    ├── .gitkeep
    └── index.ts
```

The split between `application/ports/` and `application/use-cases/` matches the convention used in `modules/catalog/application/`; if the existing `catalog/` shape uses a flatter layout (no `ports/` subfolder), drop the subfolder here too and place the same number of empty index files at the level the existing layout dictates. **Action**: open `apps/catalog-microservice/src/modules/catalog/application/` first and clone its substructure exactly. Do not innovate.

## `apps/catalog-microservice/src/modules/pricing/infrastructure/pricing.module.ts`

Concretely:

```ts
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

@Module({
  imports: [TypeOrmModule.forFeature([])], // entities added in task-02
  providers: [],
  controllers: [],
  exports: [],
})
export class PricingModule {}
```

The empty `TypeOrmModule.forFeature([])` is intentional — its presence asserts the typeorm wiring exists so the boundaries linter sees an `infrastructure` element; task-02 swaps the empty array for `[PriceEntity, TaxCategoryEntity]`.

## `apps/catalog-microservice/src/app/app.module.ts` — modification

Add `PricingModule` (imported from `…/modules/pricing`) to the `imports:` array, immediately after `CatalogModule`. Maintain the existing alphabetic / topological ordering convention used for the catalog module imports. Concrete diff intent:

```ts
import { CatalogModule } from '../modules/catalog';
import { PricingModule } from '../modules/pricing';

@Module({
  imports: [
    LoggerModule,
    DatabaseModule.forRoot([/* … existing entities … */]),
    MessagingModule,
    CatalogModule,
    PricingModule,
  ],
})
export class AppModule {}
```

## `libs/messaging/routing-keys.constants.ts` — modification

Add two new entries inside `ROUTING_KEYS`, alphabetically positioned inside the existing `catalog.*` group:

```ts
CATALOG_PRICE_CHANGED: 'catalog.price.changed',
CATALOG_PRICE_SCHEDULED: 'catalog.price.scheduled',
```

The dotted shape (`catalog.price.changed`) honors ADR-008. Note: the namespace is `catalog.*`, not `pricing.*` — pricing colocates with catalog by epic charter (the cross-cutting decision was that pricing is a sibling module inside `catalog-microservice`, not a new microservice).

## `libs/cache/cache-keys.ts` — modification

Add, near the existing per-aggregate version constants:

```ts
const CATALOG_PRICE_KEY_VERSION = 'v1';
```

Add, inside `CACHE_KEYS`, in the "Current convention (ADR-022)" group:

```ts
catalogPricePrefix: (variantId: number, opts?: ITenantOptions): string =>
  `${rootPrefix(opts)}catalog:price:${CATALOG_PRICE_KEY_VERSION}:${variantId}:`,

catalogPrice: (variantId: number, currency: string, opts?: ITenantOptions): string =>
  `${CACHE_KEYS.catalogPricePrefix(variantId, opts)}${currency.toUpperCase()}`,
```

Rationale comment block to add directly above the new builders:

> Pricing reads are NOT cached on the read path yet — the read-volume threshold for the `Select Applicable Price` query is unmet at the walking-skeleton stage (epic-03's "Architectural Decisions Honored" section). The builder is registered eagerly so the future wire-up has one canonical key family, and so the v1 schema-version segment exists at the moment the first cached read goes live (avoiding a rolling-deploy invalidate window). Tenancy is opt-in via `opts.tenantId`, matching ADR-022.

No corresponding `catalogPriceLegacyPrefix` is added — this is a brand-new key family, no transition window exists.

## `eslint.config.mjs` — verification

The existing `boundaries/element-types` config in `eslint.config.mjs` is expected to match the new `pricing/` tree without any change, because the pattern uses `apps/*/src/modules/*/` (the module name is wildcarded). To be defensive:

1. Run `yarn lint apps/catalog-microservice/src/modules/pricing` after the scaffold lands.
2. Confirm there are no `boundaries/element-types: unknown-element` warnings.
3. If any warning appears, add an explicit allowlist entry for the module path inside the boundaries `elements:` array — the entry shape mirrors what the existing `catalog/` module path captures. Document the result (no change vs. explicit allowlist) in the doc deliverable.

There is one boundary rule that **must** apply to the new tree and must be reflected in `eslint.config.mjs` (or the spec): the cross-module ban — `pricing/domain/**` must not import from `catalog/**`, and vice-versa. The two modules communicate by the `variantId` value (a `number` FK in persistence; an opaque value in domain). Concretely, augment the `boundaries/element-types` `allow:` matrix so the `domain` element under `pricing/` is not permitted to import from any `domain` / `application` / `infrastructure` element under `catalog/`. If the existing config already enforces no-cross-module-imports module-globally, no additional rule is needed — verify and document.

## `spec/architecture-lint.spec.ts` — fixture extension

Append a new `describe('catalog-microservice pricing module boundaries', () => { … })` block. Inside, three test groups:

1. **Allowed imports.** A `pricing/application/use-cases/foo.use-case.ts` fixture imports from `pricing/domain/` — green; a `pricing/infrastructure/persistence/bar.repository.ts` fixture imports from `pricing/application/ports/` — green.
2. **Forbidden cross-module imports.** A `pricing/domain/x.model.ts` fixture importing from `catalog/domain/` — reports `boundaries/element-types`. A `catalog/domain/x.model.ts` fixture importing from `pricing/domain/` — reports `boundaries/element-types`.
3. **Forbidden layer violations.** A `pricing/domain/x.model.ts` fixture importing from `pricing/infrastructure/` — reports `boundaries/element-types`.

Mirror the existing `catalog/` fixture block; copy its synthetic-path setup helper if one exists.

## Files to add

- `apps/catalog-microservice/src/modules/pricing/index.ts` (empty barrel).
- `apps/catalog-microservice/src/modules/pricing/domain/.gitkeep`.
- `apps/catalog-microservice/src/modules/pricing/domain/index.ts` (empty barrel).
- `apps/catalog-microservice/src/modules/pricing/application/.gitkeep`.
- `apps/catalog-microservice/src/modules/pricing/application/ports/.gitkeep` (only if `catalog/` uses this subfolder shape).
- `apps/catalog-microservice/src/modules/pricing/application/ports/index.ts`.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/.gitkeep`.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/index.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/pricing.module.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/.gitkeep`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/index.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/messaging/.gitkeep`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/messaging/index.ts`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/index.ts`.
- `apps/catalog-microservice/src/modules/pricing/presentation/.gitkeep`.
- `apps/catalog-microservice/src/modules/pricing/presentation/index.ts`.
- `docs/implementation/03-pricing-price-and-tax-category/01-pricing-module-scaffold.md`.

## Files to modify

- `apps/catalog-microservice/src/app/app.module.ts` — add `PricingModule` to `imports:`.
- `libs/messaging/routing-keys.constants.ts` — add the two new `CATALOG_PRICE_*` entries.
- `libs/cache/cache-keys.ts` — add `CATALOG_PRICE_KEY_VERSION` and the two `catalogPrice*` builders + rationale comment.
- `eslint.config.mjs` — only if a defensive allowlist or cross-module rule extension is required; otherwise leave unchanged and document why.
- `spec/architecture-lint.spec.ts` — append the new pricing fixture block.

## Files to delete

None.

## Tests

- No domain spec exists yet — the new module has no business logic until task-02.
- The arch-lint spec extension (`spec/architecture-lint.spec.ts`) is the only new test in this task. It must run green under `yarn test:unit`.
- The boot smoke test is the boundary: `docker compose up -d mysql rabbitmq redis && yarn start:dev:catalog-microservice` must log the same Nest microservice startup line as before, with no new error frames produced by importing the empty `PricingModule`.

## Doc deliverable

Write `docs/implementation/03-pricing-price-and-tax-category/01-pricing-module-scaffold.md`. Target ~150 lines. Sections:

1. **Why a sibling module, not a new microservice.** Cite the epic charter — pricing colocates with catalog because (a) `Price.variantId` is an inward FK to `product_variant.id` and the two aggregates share a transaction boundary for `Set Price` (the predecessor row's `valid_to` close must be atomic with the new row's insert), (b) every consumer of pricing is also a consumer of catalog reads, (c) splitting the bounded contexts later is a Day-2 question. ADR-004/009/012/013 (per-module hexagonal) explicitly permits multiple sibling modules under one app.
2. **The per-module shape, recapped.** Reference the canonical layout used by `modules/catalog/`. Note that the new `pricing/` tree mirrors it line-for-line. Call out the four element types (`domain`, `application`, `infrastructure`, `presentation`) and how `eslint-plugin-boundaries` captures them via the `apps/*/src/modules/*/` glob.
3. **The cross-module import ban.** `pricing/domain/**` must not import from `catalog/**` (and vice-versa). The two modules communicate by passing `variantId: number` across a port; in persistence, it is a FK (`price.variant_id REFERENCES product_variant.id`). This is a write-time integrity choice — within the same MySQL schema, the FK gives us deterministic delete-restrict semantics for variant archival (task-02 documents this in detail). At the domain level the two modules know nothing of each other.
4. **The two new routing keys.** Why they live under `catalog.*` and not `pricing.*` (the message namespace mirrors the bounded context of the microservice, not the module). What they are reserved for in task-03. Why they are registered eagerly here rather than at the point of first emission (avoids a routing-key-rebind window during the rolling deploy that introduces pricing events).
5. **The cache-key builder.** Why a key family is registered eagerly even though no read is cached in this epic. The v1 schema-version segment per ADR-022. Why no legacy / invalidate-only prefix is included.
6. **Boundaries lint coverage.** How the existing `eslint-plugin-boundaries` config governs the new tree. What was added to `spec/architecture-lint.spec.ts` to give CI regression coverage on the cross-module import ban.
7. **What this task did NOT do.** Cross-references to task-02 (Price + TaxCategory domain + persistence + migration), task-03 (use cases + event payloads + RPC patterns), task-04 (publish-product hard-fail), task-05 (api-gateway endpoints).

## Carryover produced (consumed by task-02 onward)

- `apps/catalog-microservice/src/modules/pricing/` exists as an empty-but-recognised per-module hexagonal tree. Task-02 fills `domain/`, `infrastructure/persistence/`, `application/ports/`.
- `ROUTING_KEYS.CATALOG_PRICE_CHANGED` + `ROUTING_KEYS.CATALOG_PRICE_SCHEDULED` are available; task-03's event publisher will emit on these.
- `CACHE_KEYS.catalogPrice` + `.catalogPricePrefix` are available; no consumer wires them in this epic.
- The arch-lint spec asserts the cross-module import ban; later tasks must not break it (and a future contributor adding a `pricing → catalog/domain` import will be caught by `yarn test:unit`).
- Doc `01-pricing-module-scaffold.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`) including on `apps/catalog-microservice/src/modules/pricing/`.
- [ ] `yarn test:unit` passes; the new pricing arch-lint fixture block is green; the two cross-module-import-ban fixtures (positive + negative) both fire as expected.
- [ ] `yarn build:catalog-microservice` produces `dist/apps/catalog-microservice/main.js` without error; the build picks up the new `PricingModule` import.
- [ ] `docker compose up -d mysql rabbitmq redis && yarn start:dev:catalog-microservice` boots cleanly with the new module imported. No new error frames in the startup log.
- [ ] `grep -nE "catalog\.price\.(changed|scheduled)" libs/messaging/routing-keys.constants.ts` shows exactly two matches.
- [ ] `grep -nE "catalogPrice(Prefix)?" libs/cache/cache-keys.ts` shows exactly the two new builder entries.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `01-pricing-module-scaffold.md` exists at the path above and is filled per the section list.
