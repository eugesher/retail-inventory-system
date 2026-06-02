# Carryover 03 → task-04

Task-03 ("Product and ProductVariant domain") is complete. This note is the
entry state for task-04 (catalog `product` / `product_variant` persistence).

## Entry state for task-04

- The catalog **write-side domain** now exists, framework-free, under
  `apps/catalog-microservice/src/modules/catalog/domain/`. It imports only
  `@retail-inventory-system/{ddd,common}` (boundaries green).
- **No persistence yet.** No entities, mappers, repository, or migration. The
  catalog `product` / `product_variant` tables still do **not** exist — that is
  task-04. `app.module.ts` still omits `DatabaseModule.forRoot(...)`;
  `catalog.module.ts` is still an empty `@Module({})`.
- The `product` table name is free (task-02 dropped the inventory stub).
- All gates green on a fresh run: `yarn lint` (exit 0), `yarn test:unit`
  (**335 passed**, 47 suites — was 313, +22 catalog domain specs), `yarn build`
  (5 apps), `yarn test:e2e` (5 suites / 55 tests / 38 snapshots), and the
  self-containment grep is clean.

## Files added

Domain (all under `apps/catalog-microservice/src/modules/catalog/domain/`):

- `product.model.ts` — `Product extends AggregateRoot<number | null>`. Factories
  `create({ name, slug, description? })` (draft, no variants, **no event**) and
  `reconstitute(props)`. Methods `addVariant(input)`, `publish()`, `archive()`,
  plus `isDraft()/isActive()/isArchived()` and getters. Exports the
  `AddVariantInput` type (`Omit<IProductVariantProps, 'id'|'productId'|'status'|'createdAt'|'updatedAt'>`).
- `product-variant.model.ts` — `ProductVariant extends Entity<number | null>`
  (child entity, **not** an aggregate). Constructor validates sku/weightG and
  builds the `OptionValues` / `Dimensions` VOs. Getters expose the **raw**
  `optionValues: Record<string,string>` and `dimensionsMm: {l,w,h}|null` (the
  shapes persistence/read want — VOs stay internal). Exports `IProductVariantProps`.
- `product-status.enum.ts` — `ProductStatusEnum { DRAFT='draft', ACTIVE='active', ARCHIVED='archived' }`.
- `product-variant-status.enum.ts` — `ProductVariantStatusEnum { ACTIVE='active', ARCHIVED='archived' }`.
- `option-values.vo.ts` — `OptionValues` VO (non-empty map of non-empty
  string→string; `.value` returns a defensive copy).
- `dimensions.vo.ts` — `Dimensions` VO (`l`/`w`/`h` non-negative integer mm;
  `.value` / `.l` / `.w` / `.h`).
- `catalog.exception.ts` — `CatalogDomainException extends DomainException`
  (first concrete consumer of `libs/common`'s `DomainException`) +
  `CatalogErrorCodeEnum` (8 codes).
- `events/variant-created.event.ts`, `events/product-published.event.ts`,
  `events/product-archived.event.ts`, `events/index.ts`.
- `index.ts` (domain barrel).
- `spec/product.model.spec.ts`, `spec/product-variant.model.spec.ts`.

Docs:

- `docs/adr/025-catalog-product-and-variant-aggregate.md` — **ALLOCATED AND
  COMMITTED** (Date 2026-06-02, Status Accepted).
- `docs/implementation/02-catalog-product-and-variant/03-product-and-variant-domain.md`.

## Files modified

- `docs/adr/index.md` — appended the ADR-025 row.

## Files NOT modified (deliberate)

- `apps/catalog-microservice/src/modules/catalog/index.ts` — **left unchanged**
  (`export * from './catalog.module'`). The task's "Files to modify" hedged this
  with "**if that matches the inventory/notification convention**" — it does
  **not**: the inventory/retail/notification `modules/<name>/index.ts` barrels
  re-export only `infrastructure/*` (the Nest module, and persistence), never
  `domain/`. The domain is consumed via `domain/index.ts` relative imports
  (specs do `from '..'`; later use cases will do `from '../../domain'`). Adding
  a domain re-export at the module barrel would diverge from the convention.
- `CLAUDE.md` — **left unchanged** per the task plan (the "next free number is
  025" line + a catalog domain section are updated in **task-10**, the docs
  finalization). `README.md` — untouched (domain-only; no routes/schema/services
  changed).

## Event class names + payloads (task-05/06 map these to versioned `v1` wire events)

All three extend `DomainEvent<number>`; the base `aggregateId` **is the
productId** (each event also exposes a `productId` getter aliasing it). The use
case drains them via `pullDomainEvents()` after the repo round-trip and maps to
the wire — a `DomainEvent` subclass is **never serialized cross-service**.

| Class | Recorded by | Payload (beyond `aggregateId`/`productId`) |
|---|---|---|
| `VariantCreatedEvent` | `Product.addVariant(...)` | `variantId: number \| null`, `sku: string` |
| `ProductPublishedEvent` | `Product.publish()` | `slug: string`, `variantIds: number[]` |
| `ProductArchivedEvent` | `Product.archive()` | — |

- **`VariantCreatedEvent.variantId` is `number \| null`** — null when
  `addVariant` runs before first save. **task-05's use case must re-read the
  concrete variant id from the saved aggregate before emitting the wire event.**
- `ProductPublishedEvent.variantIds` filters out null ids in the aggregate;
  publish always runs against a persisted product, so it is concrete.

## Key decisions & deviations

- **Repository-level uniqueness (action for task-04/05).** `Product.slug` and
  `ProductVariant.sku` are **globally unique**, but the domain **cannot** enforce
  it (no cross-aggregate view) and does **not** try. **task-04 must add UNIQUE
  constraints** on `product.slug` and `product_variant.sku` in the migration.
  **task-05 must assert the uniqueness rejection** in the register/add-variant
  use-case specs via a repository test double. A comment in
  `product.model.spec.ts` already points there.
- **Status enums live in `domain/`, not `libs/contracts`** — they are internal
  domain concepts, not cross-service contracts (divergence from `Order`, whose
  `OrderStatusEnum` is in contracts because the wire DTOs name it). If a catalog
  wire DTO later needs a status, give the versioned DTO its own representation
  rather than coupling the domain enum to transport.
- **Status held as the raw enum on the model**, not wrapped in a status VO
  (unlike `OrderStatusVO`). Transition predicates are plain methods
  (`isDraft()` etc.). The task's VO examples were `option-values`/`dimensions`,
  not status.
- **`Dimensions` VO enforces non-negative integer mm** — a domain-reasonable
  invariant the task did not strictly list, added for symmetry with the
  `weightG` rule. task-04's mapper can rely on dims being validated.
- **`CatalogDomainException` + `CatalogErrorCodeEnum`** — first concrete
  `DomainException` subclass in the repo (older aggregates throw plain `Error`).
  Codes: `PRODUCT_NAME_REQUIRED`, `PRODUCT_SLUG_REQUIRED`,
  `PRODUCT_INVALID_STATE_TRANSITION`, `PRODUCT_PUBLISH_REQUIRES_VARIANT`,
  `VARIANT_SKU_REQUIRED`, `VARIANT_OPTION_VALUES_REQUIRED`,
  `VARIANT_WEIGHT_INVALID`, `VARIANT_DIMENSIONS_INVALID`. The
  application/presentation layer can map a code → HTTP status (task-08).
- **No `ProductCreated` event** — only the three state-meaningful events.
  `Product.create(...)` records nothing.
- **`publish()` active-Price precondition is a documented seam, not code.** The
  domain enforces only "≥1 variant". The "≥1 active Price" check belongs to a
  future pricing capability; **task-06's publish use case warns (not blocks) on a
  price-less product** — the warn lives in the use case, not the domain.

## Known gaps (owned by later tasks)

- **Persistence** (`Product`/`ProductVariant` TypeORM entities, mappers,
  `IProductRepositoryPort` + typeorm repo, `DatabaseModule.forRoot(...)`, the
  create-tables migration with the `slug`/`sku` UNIQUE constraints, idempotent
  seed) — **task-04**.
- **Register + add-variant use cases** (assert slug/sku uniqueness via repo
  double; map `VariantCreatedEvent` to the wire after persistence) — **task-05**.
- **Publish + archive use cases** (the active-Price warn-not-block lives here) —
  **task-06**.
- **Query read path** (top-level variant addressing as a read model) — **task-07**.
- **API gateway catalog module** (HTTP surface; map `CatalogErrorCodeEnum` →
  HTTP status) — **task-08**.
- **Kulala `http/catalog.http`** — **task-09**.
- **Seed + docs finalization** (incl. CLAUDE.md "next free number" bump to 026 +
  a catalog domain section; README updates) — **task-10**.
- **`product_id` → `variantId` reshape** in inventory/retail, and retail
  order-create validation against a published variant — owned by later
  cross-context work, **not** tasks 04–10 (carried over from carryover-02).

## How to verify

```bash
yarn lint                 # --max-warnings 0, exit 0
yarn test:unit            # 335 passed, 47 suites (catalog domain specs green)
yarn build                # 5 apps compile

# Regression (infra reload + migrate + seed + tests):
yarn test:e2e             # 5 suites / 55 tests / 38 snapshots

# Self-containment gate (expected: no orchestration references):
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
```

Note: infra (rabbitmq/mysql/redis) was left **up** after the e2e run; tear it
down with `yarn test:infra:down` for a clean slate.
