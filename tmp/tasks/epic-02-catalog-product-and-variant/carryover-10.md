# Carryover 10 (final) — catalog seed + docs + lint-fixtures finalization

Task-10 ("Seed, docs, and lint-fixtures finalization") is complete. This is the
**last** note in the catalog group — it records the final on-disk state and the
full verification set proving every cumulative exit criterion of the group.

## What this task closed

- **Standing catalog seed** so other capabilities can address products/variants
  by stable id.
- **Catalog boundary fixtures** in `spec/architecture-lint.spec.ts` (the
  regression bumpers the catalog tree previously lacked).
- **README.md + CLAUDE.md** brought fully into line with the catalog service.
- The **final repo-wide self-containment grep** (clean).

No production behaviour changed; no migration was authored (the catalog tables
already exist from the persistence work).

## Standing seed (idempotent)

Two new SQL files, modelled on the existing `scripts/seeds/*.sql` (`INSERT
IGNORE` + explicit stable ids), registered in `scripts/utils/test-db-seed.util.ts`
**after** the existing entries, **parent before child** (FK
`product_variant.product_id → product.id`):

- `scripts/seeds/catalog-product.sql` — **2 products, `active`**:
  - id 1 `Aurora Desk Lamp` / slug `aurora-desk-lamp`
  - id 2 `Nimbus Office Chair` / slug `nimbus-office-chair`
- `scripts/seeds/catalog-product-variant.sql` — **4 variants, `active`** (2 per
  product, distinct SKUs, valid JSON `option_values` / `dimensions_mm`):
  - id 1 `AURORA-WARM` (product 1), id 2 `AURORA-COOL` (product 1)
  - id 3 `NIMBUS-BLACK` (product 2), id 4 `NIMBUS-GREY` (product 2)

**Final `seedFiles` order** (`TestDbSeedUtil.seedFiles`):

```
['product-stock.sql', 'order.sql', 'order-product.sql',
 'catalog-product.sql', 'catalog-product-variant.sql']
```

**Idempotency proven:** `yarn test:seed` run twice in a row → exit 0 both times,
and the row counts stay exactly `product=2` / `product_variant=2 per product`
(no duplicates). `INSERT IGNORE` + explicit ids is the mechanism.

**Slug/SKU values deliberately avoid the `http/catalog.http` literals**
(`aeron-chair`, `AERON-CHAIR-*`) so the `.http` register block runs clean against
a seeded DB — verified live: a register→…→archive replay landed `aeron-chair` at a
fresh id alongside the two seeded products, and the active browse returned **3**
products (the two seeded + `aeron-chair`).

## Architecture-lint fixtures added (`spec/architecture-lint.spec.ts`)

A new `describe('boundaries/dependencies — catalog microservice', …)` block (7
fixtures) mirroring the inventory/gateway bumpers, virtual fixtures pointed at
**real** catalog paths (the generic `apps/*/src/modules/*/...` element patterns
classify them automatically — no `ELEMENTS` / `DEPENDENCY_RULES` change):

| Fixture path (`apps/catalog-microservice/src/modules/catalog/…`) | Asserts `boundaries/dependencies` fires on |
|---|---|
| `domain/__fixture__.ts` | `import '@nestjs/common'` |
| `domain/__fixture__.ts` | `import 'typeorm'` |
| `application/use-cases/__fixture__.ts` | `import 'typeorm'` |
| `application/use-cases/__fixture__.ts` | `import '@nestjs/typeorm'` |
| `application/ports/__fixture__.ts` | `import 'typeorm'` |
| `presentation/__fixture__.ts` | `import '@retail-inventory-system/database'` |
| `presentation/__fixture__.ts` | `import 'typeorm'` |

The suite total went 23 → **30** boundary tests (all green). These are
regression bumpers — a future refactor cannot silently exempt the catalog tree.

## README.md sections updated

- **Services table** — the `catalog-microservice` row (RMQ-only, `catalog_queue`,
  owns Product + ProductVariant) was already present from earlier work; left as-is
  (complete).
- **System diagram** — the Catalog Microservice box + `catalog_queue` + its
  routing keys were already present; the standalone inventory `product` box/table
  was already gone (dropped during the stub-removal work). Added a **`variantId`
  caption** below the diagram: every downstream cluster (inventory stock, pricing,
  order/cart lines) keys on `variantId`, not `productId`; the
  `product_stock.product_id` / `order_product.product_id` columns are now plain
  FK-free integers awaiting a later reshape onto `variantId`.
- **API → Catalog** — the seven-endpoint list with auth notes was already present;
  left as-is.
- **Architecture-lint prose** — corrected the regression-suite path from the
  non-existent `tests/lint/architecture-lint.spec.ts` to the real
  `spec/architecture-lint.spec.ts`, and noted it now covers the catalog module.

## CLAUDE.md sections updated

- **App tree** — refreshed the stale `catalog-microservice/` one-liner ("…
  register/add-variant write use cases & events" → "domain, persistence, four
  write use cases + three read queries, and the catalog event seam").
- **New Catalog microservice file-tree section** — added after the retail tree in
  "Microservices (per-module hexagonal layout)", mirroring the
  notification/inventory/retail template blocks (domain / application / infra /
  presentation, the ports + symbols, the `CatalogRabbitmqPublisher` event seam,
  the controller's seven RPCs). **Notes the one divergence**: the catalog
  microservice's `catalog.module.ts` sits at the **module root**, not under
  `infrastructure/` (inventory/retail put theirs under `infrastructure/`). Updated
  the section's intro to "notification, inventory, retail, and catalog".
- **Message patterns / RabbitMQ queues / `MicroserviceClientCatalogModule`** —
  already present from earlier work; left as-is (verified complete).
- **Architecture-rules ADR pointer** — bumped "next free number is `025`" →
  "`026`" (ADR-025 is committed) and the example range `024-…` → `025-…`.
- **Architecture-lint prose** — same `tests/lint/…` → `spec/architecture-lint.spec.ts`
  path correction as README, plus the catalog-module coverage note.

## Final self-containment grep — CLEAN

```
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
# → exit 1, no matches (no orchestration references anywhere outside tmp/)
```

Also re-checked the new/edited files specifically (seed SQL, seed util, spec) —
clean.

## Files added

- `scripts/seeds/catalog-product.sql`
- `scripts/seeds/catalog-product-variant.sql`

## Files modified

- `scripts/utils/test-db-seed.util.ts` — appended the two seed files to
  `seedFiles` (parent before child).
- `spec/architecture-lint.spec.ts` — the catalog `describe` block (7 fixtures).
- `README.md` — `variantId` caption + lint-suite path/coverage correction.
- `CLAUDE.md` — app-tree one-liner, the Catalog microservice file-tree section,
  the section intro, the ADR "next free number" bump, the lint-suite path/coverage
  correction.

## Files deleted

- None.

## Known gaps (carried out of this group, owned by later cross-context work)

- **Precise catalog error → HTTP mapping.** A catalog domain rejection (duplicate
  slug, publish-without-variant, etc.) currently surfaces as **500** at the
  gateway, because the catalog microservice raises a plain `CatalogDomainException`
  (not an `RpcException`) and Nest's RMQ transport flattens any non-`RpcException`.
  Making it precise (`PRODUCT_NOT_FOUND`/`VARIANT_NOT_FOUND`→404, `*_TAKEN`→409,
  invariant/transition→400) requires the **catalog microservice** to serialize a
  structured `RpcException` carrying the status (the pattern retail's
  `OrderConfirmPipe` uses). Not in this group's scope.
- **Pricing capability.** The "≥1 active Price" publish precondition is still a
  warn-not-block seam in the microservice's `publish-product.use-case.ts`; a future
  pricing capability turns it into a hard check.
- **`product_id` → `variantId` reshape.** Inventory `product_stock.product_id` and
  retail `order_product.product_id` remain plain FK-free integers; reshaping them
  onto a catalog `variantId` (and restoring retail order-create validation against
  a published variant) is later cross-context work.

## How to verify (full cumulative set — all green)

```bash
# Static
yarn lint                 # --max-warnings 0, exit 0
yarn test:unit            # 378 passed, 55 suites (architecture-lint: 30 boundary
                          #   tests incl. the 7 new catalog fixtures)

# Schema + seed + e2e on a fresh slate
yarn test:infra:reload    # down -v → up → migration:run → test:seed (seeds the
                          #   2 products + 4 variants)
yarn test:seed            # second run → exit 0, no error, no duplicate rows
yarn test:e2e:run         # 6 suites / 67 tests / 38 snapshots; test/catalog.e2e green

# Row-count idempotency check
docker exec mysql mysql -uretail -pretailpass retail_db -N -e \
  "SELECT (SELECT COUNT(*) FROM product), (SELECT COUNT(*) FROM product_variant);"
#   → 2   4

# Boot all five services + live read of the standing seed
./.claude/skills/run-retail-inventory-system/driver.sh start   # reuses seeded infra
docker exec rabbitmq rabbitmqctl list_queues name consumers    # catalog_queue → 1
curl -s 'http://localhost:3000/api/catalog/products?status=active&page=1&pageSize=20'
#   → total=2, items = Aurora Desk Lamp (2 variants) + Nimbus Office Chair (2 variants)
# Optional: replay http/catalog.http (login → register aeron-chair → +2 variants →
#   publish → list(=3) → get-by-slug → get-variant → archive → list(search=aeron, =0));
#   the seeded products coexist and stay resolvable throughout.
./.claude/skills/run-retail-inventory-system/driver.sh stop

# Self-containment gate (expected: exit 1 / no matches)
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
```

Note: the test infra (rabbitmq/mysql/redis) was left **up and seeded** after this
run; the driver app processes were stopped. Tear infra down with
`yarn test:infra:down` for a clean slate.
