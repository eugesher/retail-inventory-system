# Catalog and pricing

What the catalog microservice's two modules, `catalog` and `pricing`
(`apps/catalog-microservice/src/modules/`), do today, beyond what their names and types say. It
covers products and variants, the category tree and product membership, media, prices and tax
categories, and how each of them fails. Paths below are relative to that folder unless they start
at the repository root. The rationale lives in the ADRs:
[ADR-025](../adr/025-catalog-product-and-variant-aggregate.md) (the `Product` aggregate, the
last-writer-wins stance and the publish price gate),
[ADR-026](../adr/026-price-append-only-ledger-and-tax-category.md) (the price ledger, its
open-row invariant and the tax-category label), and
[ADR-029](../adr/029-category-materialized-path-and-polymorphic-media.md) (the materialized path,
the bare membership join, polymorphic media and the soft media warning). Payload and view rules are
in [`wire-contracts.md`](wire-contracts.md#catalog-and-pricing). The code-to-status tables are
`catalog/presentation/catalog-rpc-exception.filter.ts` and
`pricing/presentation/pricing-rpc-exception.filter.ts`.

## `Product` and `ProductVariant`

- **Add Variant accepts a product in any status**, archived included. `Product.addVariant` has no
  status guard, and `AddVariantUseCase.execute` checks only that the product exists and the `sku`
  is free (`catalog/domain/product.model.ts`). Two consequences:
  - The price gate runs only at publish. A variant added to an `active` product goes on sale with no
    check that it has a price.
  - A variant added to an `archived` product still publishes `catalog.variant.created`, and
    inventory still creates its zeroed stock level.
- **Publish checks the price before the status**
  (`catalog/application/use-cases/publish-product.use-case.ts`, `PublishProductUseCase.execute`):
  1. the product exists (`PRODUCT_NOT_FOUND`);
  2. every variant has a price in effect in `CATALOG_DEFAULT_CURRENCY`
     (`PRODUCT_PUBLISH_REQUIRES_PRICE`);
  3. the product is a `draft` with at least one variant (`PRODUCT_INVALID_STATE_TRANSITION`,
     `PRODUCT_PUBLISH_REQUIRES_VARIANT`).

  An `active` or `archived` product with an unpriced variant therefore answers
  `PRODUCT_PUBLISH_REQUIRES_PRICE`, not the transition error. A product with no variants sends an
  empty list to the probe, which answers "nothing missing" without a query, so it fails at step 3.

- **The media recommendation runs after the commit and after the event.** It checks the product and
  every variant in one query. If that query fails, the failure is logged at `warn` and the response
  carries no warning, because the absence of media cannot be proven
  (`PublishProductUseCase.collectMediaWarnings`).
- **Every save rewrites the root and every variant it loaded, in one transaction**, then re-reads
  the graph (`catalog/infrastructure/persistence/catalog-typeorm.repository.ts`,
  `CatalogTypeormRepository.save`). There is no version column (ADR-025 §3), so two concurrent
  writes to one product both succeed, and the later one decides every column it wrote. Variants are
  never deleted by a save.
- **Only the `Category` slug is kebab-case in the domain.** `Product` requires a non-empty slug and
  nothing more. The kebab-case pattern for a product slug is enforced by the gateway DTO alone
  (`apps/api-gateway/src/modules/catalog/presentation/dto/validation.constants.ts`, `SLUG_PATTERN`).
  A direct RMQ caller can register a product whose slug has spaces or capitals.
- **A blank `gtin` is stored as `NULL`,** and a non-blank one is trimmed
  (`catalog/domain/product-variant.model.ts`, `ProductVariant` constructor). This matters because
  `UC_PRODUCT_VARIANT_GTIN` admits many `NULL`s but only one `''`. No use case pre-checks the
  `gtin`, so a duplicate reaches the database (see [Failure modes](#failure-modes)).
- **No operation archives a variant.** Variants are born `active` and stay so. The "active variants
  only" filter in the read views (`toProductWithVariantsView`) therefore drops nothing today.

## Categories

- **No operation archives a category.** `Category.archive` has no production caller and there is no
  archive route. Every rule about an archived category guards only rows changed by hand in the
  database:
  - Create and Reparent refuse an archived parent with `409 CATEGORY_ARCHIVED`
    (`CreateCategoryUseCase.execute`, `ReparentCategoryUseCase.execute`);
  - Reclassify refuses to attach a product to an archived category, and still detaches from one;
  - the tree, list and product-list reads treat an archived category as missing.
- **An archived intermediate hides its branch from the tree, not from the product list.**
  - `catalog.category.get-tree` builds the tree from the active nodes, so an active child whose
    parent is archived never attaches to anything (`GetCategoryTreeUseCase`,
    `assembleCategoryTree`).
  - `catalog.category.list-products` with `includeDescendants` collects every active node under
    the path prefix and ignores the parents (`ListCategoryProductsUseCase.execute`). It therefore
    includes the products of an active category below an archived one.
- **Reparenting to the current parent writes nothing.** The recomputed path equals the old one, so
  the repository opens no transaction, bumps no `updated_at`, and reports
  `rewrittenDescendantCount: 0`
  (`catalog/infrastructure/persistence/category-typeorm.repository.ts`,
  `CategoryTypeormRepository.reparentSubtree`).
- **The subtree `LIKE` is bound without escaping,** both in `listSubtree` and in the reparent rebase
  (`<path>/%`). That is safe only because the domain slug pattern admits neither `%` nor `_`
  (`catalog/domain/category.model.ts`, `SLUG_REGEX`).
- **Category writes read outside their transaction, and nothing locks the tree.**
  - Create derives the child's path from a parent it read first.
  - Reparent runs its cycle test on rows it read first.

  Neither re-checks inside the write, and `category` has no version column (see
  [Failure modes](#failure-modes)).

### Product membership

`catalog/application/use-cases/reclassify-product.use-case.ts`, `ReclassifyProductUseCase.execute`.

- **Order of checks:**
  1. the product exists, in any status (`PRODUCT_NOT_FOUND`);
  2. every attach slug resolves (`CATEGORY_NOT_FOUND`) and is not archived (`CATEGORY_ARCHIVED`);
  3. every detach slug resolves (`CATEGORY_NOT_FOUND`).

  Within one list, the lookups run concurrently, but the first failing slug in payload order decides
  the error. Every check runs before any write.

- **The attach and the detach are two separate statements, not one transaction.** The attach runs
  first, so a slug named in both lists ends detached.

## Media

- **Attach takes the slot after the owner's highest `sort_order`, archived rows included**
  (`catalog/infrastructure/persistence/media-asset-typeorm.repository.ts`,
  `MediaAssetTypeormRepository.maxSortOrder`). The first asset gets `0`.
- **Reorder renumbers only the active rows**, `0` to `N − 1`, in one transaction
  (`MediaAssetTypeormRepository.reorder`). Archived rows keep their old slot, so after a reorder an
  active and an archived row can share one. Reads order by `sort_order`, then `id`.
- **Attach checks that the owner exists, not its status.** Media can be attached to an archived
  product or variant (`AttachMediaUseCase.assertOwnerExists`).
- **Reorder checks its id set outside the transaction.** Each `UPDATE` is also scoped to the owner,
  so an id of another owner's asset changes nothing.

## Prices

- **Two clocks decide whether a price is in effect.** `Price.set` checks `validFrom` against the
  Node clock, and Select Applicable and List Prices default `asOf` to the Node clock too. The
  publish probe compares against `UTC_TIMESTAMP()`, the database clock
  (`catalog/infrastructure/persistence/active-price-probe.typeorm.adapter.ts`,
  `ActivePriceProbeTypeormAdapter.findVariantsMissingActivePrice`). Why the driver's UTC pin is
  what makes the probe correct is in [`README.md` §9](../../README.md#migrations). With the pin in
  place, the two readers disagree only by the clock skew between the hosts.
- **`valid_from` and `valid_to` hold whole seconds.** Both are `TIMESTAMP` columns
  (`migrations/1780546069117-CreatePricingTables.ts`). `mysql2` sends milliseconds and MySQL rounds
  them to the nearest second, so:
  - A price set "now" can be stored up to half a second in the future. For that half second,
    Select still returns the previous price, or none.
  - `catalog.price.changed` versus `.scheduled` is decided from the instant before rounding
    (`pricing/application/use-cases/set-price.use-case.ts`, `SetPriceUseCase.execute`). The event
    and the response then carry the stored, rounded `validFrom`.
  - Two prices set on one scope less than a second apart can get `409 PRICE_SCHEDULE_CONFLICT`. It
    happens when the first one's start was rounded up past the second one's start.
- **Every set closes the scope's open row, even a set with a `validTo`**
  (`SetPriceUseCase.resolvePredecessor`). A bounded price therefore leaves the scope with no open
  row. Once it ends, Select returns `null` and the publish gate fails, until another price is set.
  A temporary price on top of a standing one cannot be authored through `catalog.price.set`.
- **The start check compares with the open row only.** Closed rows, including a bounded one that
  starts in the future, are not consulted. When there is no open row, a new price may overlap a
  bounded one, and Select resolves the overlap by priority, then by the later start. So overlapping
  candidates come from this, not only from the scheduled rows that
  [ADR-026 §4](../adr/026-price-append-only-ledger-and-tax-category.md#4-select-applicable-resolution--coarse-query-here-policy-in-the-use-case)
  expects.
- **The open row is read before the append's transaction, without a lock.** The close and the
  insert then commit together (`pricing/infrastructure/persistence/pricing-typeorm.repository.ts`,
  `PricingTypeormRepository.appendPrice`). `UC_PRICE_OPEN_SCOPE` catches a race between two
  open-ended sets (see [Failure modes](#failure-modes)).
- **The publish probe and Select Applicable are two readers of `price`, and they ask different
  questions.** The probe asks whether any row is in effect, in the default currency, at the
  database clock. Select asks which row wins. The probe is catalog's own parameterized read,
  because catalog may not import pricing
  ([ADR-026 §5](../adr/026-price-append-only-ledger-and-tax-category.md#5-variantid-is-an-opaque-link--no-catalog-import)).

## Tax categories

- **Attach checks the category before the variant.** A missing code is `404 TAX_CATEGORY_NOT_FOUND`
  even when the variant is missing too. The variant may be in any status
  (`pricing/application/use-cases/attach-tax-category-to-variant.use-case.ts`,
  `AttachTaxCategoryToVariantUseCase.execute`).
- **The response is a re-read**, not an echo of the request. It comes from `findVariantTaxHeader`
  after the `UPDATE`.

## Events

- **Every event is built by the use case after the commit, and a publish failure is only logged at
  `warn`.** A failed primary emit skips the `ris.events` mirror, so the event is lost from both.
- **`catalog.variant.created` goes to `inventory_queue`**, which inventory consumes. The other
  four events go to `catalog_queue`: `catalog.product.published`, `.archived`,
  `catalog.price.changed` and `.scheduled`.
- **Catalog receives its own four events and discards them.** The catalog `main.ts` sets no
  `noAck`, so the queue auto-acknowledges. No `@EventPattern` exists in the service, so Nest logs
  its "no matching event handler" error and the message is gone. This is the same as
  [`inventory_queue`](inventory.md#events). The events survive only as their `ris.events` copy.
- **Category, media and tax-category writes publish nothing.**

## Failure modes

| What breaks                                                   | How it shows                                                                                                                       | What recovers it                                             |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| A variant is added to an `active` product without a price     | The variant is on sale unpriced: an Add Line or Place for it fails on the missing price                                            | Set a price for it                                           |
| A bounded price (with `validTo`) ends                         | The scope has no price: Select returns `null`, and the publish gate fails                                                          | Set a new price                                              |
| Two open-ended prices are set on one scope at the same time   | One wins. The other hits `UC_PRICE_OPEN_SCOPE`, rolls back, and reaches the caller as a bare `500`                                 | The caller retries: the retry closes the winner              |
| Two creates race on one `slug`, `sku` or tax-category `code`  | Both pass the pre-check. The loser hits the UNIQUE constraint and gets a bare `500`                                                | Nothing to recover: the winner's row stands                  |
| A duplicate non-blank `gtin`                                  | No pre-check exists, so `UC_PRODUCT_VARIANT_GTIN` fails the insert with a bare `500`                                               | Correct the `gtin`                                           |
| Two attaches to one media owner at the same time              | Both read the same maximum and take the same slot                                                                                  | Reads fall back to `id` order; a reorder renumbers them      |
| A child category is created while its parent is being moved   | The child can keep the parent's old path prefix: its `parent_id` is right and its `path` is stale, so path-based reads misplace it | Reparent the child under its parent, which rewrites its path |
| Two reparents that swap a pair of categories run concurrently | Each passes the cycle test on its own read, and the tree can end up with a cycle                                                   | Manual repair in the database                                |
| A catalog or pricing publish fails after the commit           | A `warn` log. No event, and no `ris.events` copy                                                                                   | Nothing: there is no outbox                                  |
