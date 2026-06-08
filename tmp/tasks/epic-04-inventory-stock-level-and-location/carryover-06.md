# Carryover 06 — Docs + README/CLAUDE + lint-fixtures finalization (capability close)

> The closing note for the inventory stock-level + location capability (after
> `carryover-01..05.md`). This was the documentation + guardrail pass — **no
> production code, schema, seed, or e2e behaviour changed.** (This file lives
> under `tmp/`; the self-containment rule does not apply here.)

## What this session did

Pure finalization. The inventory capability was already live on disk after
task-05; this session brought the human-facing docs fully in line with the new
model, strengthened the architecture-lint fixtures for the new `consumers/`
boundary, and ran the closing gates.

### `08-inventory-http-file.md` written

`docs/implementation/04-inventory-stock-level-and-location/08-inventory-http-file.md`
— the `http/inventory.http` walkthrough: the four gateway endpoints, the
`# Prereqs:` staff-login flow capturing `@accessToken`, the seeded figures the
requests assume (variant 1 = 100 on hand → receive 50 → 150 → adjust −3 → 147 →
adjust −100000 → `409`), the **two omit conventions** (`?locationIds` omit →
aggregate-across-all-locations on the read; `stockLocationId` omit →
`default-warehouse` on the writes), and the note that it **replaced the deleted
`http/product.http`**. Cross-links `07-availability-read-path.md` and
`06-receive-and-adjust-use-cases.md`. Docs `01`–`08` are now all present.

### `README.md` fully aligned

- **System diagram** — the inventory-microservice box now lists the read+write
  RPCs (`stock-level.get` / `location.list` / `receive` / `adjust`), shows
  `Consumes: variant.created`, marks `inventory.order.confirm` as `(stub)`, and
  keeps the `inventory.stock.low → notification` + Redis cache-aside connectors.
  The catalog box now shows `variant.created -> inventory_queue (auto-init)` and a
  Pricing line. (Box widths were preserved byte-for-byte so the ASCII connectors
  stay aligned — interior columns held at 31 for the inventory box, 63 for the
  catalog box.)
- **Inventory-microservice layout tree** — rewritten from the superseded
  `stock-item.model.ts`/`storage.model.ts`/`get-stock`/`reserve-stock`/`add-stock`
  tree to the real file set (`stock-level.model.ts`, `stock-location.model.ts`,
  `inventory.exception.ts`, the five use cases, `infrastructure/consumers/`,
  `inventory-rpc-exception.filter.ts`). The "tree above still reflects the
  superseded model" disclaimer was deleted.
- **Caching** section — the `> Status:` disclaimer block was removed; the whole
  section now describes the `v2`/`variantId` `VariantStockView` projection,
  `QueryAvailabilityUseCase` + `getOrLoad`, the point-lookup read (no
  `SUM/GROUP BY`), the Receive/Adjust `withInvalidation` writers, the **four**
  legacy-prefix fan-out, and the `ris:inventory:stock:v2:*` inspect snippet.
- **Catalog overview paragraph** — corrected the stale "`product_stock.product_id`
  survives as a plain integer" claim: inventory already keys on
  `stock_level.variant_id` (real FK); only the retail `order_product.product_id`
  still awaits a later retail reshaping.
- **Local development / seed** — added a `stock_level` fixture table (variants
  1..4, 100 on hand at `default-warehouse`) and the note that the migration
  auto-provisions the single `default-warehouse` `StockLocation` idempotently.
- **TTL table** — `CACHE_TTL_MS_PRODUCT_STOCK` was **not** renamed (carryover-02's
  decision stands); its Role text now says it governs the per-variant availability
  read and notes the env name predates the rewrite.

### `CLAUDE.md` fully aligned

- **Service Structure** header — `inventory ADR-012` → `inventory ADR-027
  (supersedes ADR-012)`.
- **Microservices → inventory bullet** — fully rewritten to the
  `StockLevel`/`StockLocation` model (aggregates, ports, the five use cases, the
  consumer, the RPC-exception filter, the gateway front). The superseded-model
  disclaimer was deleted.
- **Shared Libraries → cache bullet** — now notes ADR-022's `<version>` segment
  (`INVENTORY_STOCK_KEY_VERSION = 'v2'`, keyed on `variantId`), the legacy
  invalidate-only prefix builders, and ADR-023's `withInvalidation`.
- **Architecture decisions** — "next free number" advanced `027` → **`028`**.
- **Operational notes → cache-aside bullet** — now states the explicit
  `ris:inventory:stock:v2:<variantId>:<facet>` key + the four-prefix post-commit
  fan-out via `withInvalidation`.
- The message-pattern Inventory section, the RabbitMQ-queues paragraph, and the
  cross-service-events bullet were already current from tasks 02–05 (verified, not
  re-edited). `docs/adr/index.md` already carries the ADR-027 row and ADR-012's
  "Supersedes ADR-012" summary; ADR-012's status line already reads "Superseded by
  ADR-027" (task-01). No ADR file was edited this session.

### Architecture-lint fixtures

`spec/architecture-lint.spec.ts` — the inventory `stock` fixtures still pass
against the new file set (they resolve to the real `stock-level.entity.ts` /
`product.model.ts` targets). **Added one fixture** in the element-type-denials
block: *"infrastructure consumer may not reach another app domain (cross-app)"* —
asserts that an `infrastructure/consumers/__fixture__.ts` importing the catalog
microservice's `domain/product.model` fires `boundaries/dependencies`. This is the
**first negative `infrastructure`-layer fixture** (prior infra fixtures were all
positive) and locks the new `consumers/` boundary: the catalog-events consumer may
consume `catalog.variant.created` only through the `ICatalogVariantCreatedEvent`
wire contract (lib-contracts), never the catalog domain. A *forbidden-transport*
consumer fixture was deliberately **not** added — the `infrastructure` layer has no
external denylist (it is the only layer allowed typeorm/redis/amqp), so such a
fixture would not fire. **No `eslint.config.mjs` rule was weakened or changed**
(ADR-017); the inlined `ELEMENTS`/`DEPENDENCY_RULES` mirror is unchanged. Suite is
38 tests (was 37; +1).

## The delivered inventory capability (one paragraph)

The inventory `stock` context was re-founded ([ADR-027](../../../docs/adr/027-stocklevel-running-totals-and-stocklocation.md),
supersedes ADR-012) on two aggregates keyed on the catalog **`variantId`**:
per-location **`StockLevel`** running totals (`quantityOnHand`/`Allocated`/`Reserved`,
`available` a pure getter, a `version` optimistic-lock column shipped now) and a
first-class **`StockLocation`** (string PK; one `default-warehouse` auto-provisioned
by the migration). On top of it: the **read path** (`inventory.stock-level.get` →
`QueryAvailabilityUseCase`, cache-aside under the `v2`/`variantId` key; and
`inventory.location.list`) fronted publicly/`inventory:read` over HTTP; an
**auto-init consumer** that zeroes a `StockLevel` on `catalog.variant.created`
(catalog publisher retargeted to `inventory_queue`); and the two **write
operations** Receive (`onHand += n`) and Adjust (signed delta + `reasonCode`,
below-zero → `409`), both `inventory:adjust`-gated, both invalidating the cache
post-commit and emitting reserved-surface events, with Adjust re-firing
`inventory.stock.low` → notification at/below the threshold. **Explicit deferrals,
each owned by the later inventory-reservation / audit-log capability:**
reservation, allocation, commit-sale/cancel/restock, **transfer**, the
**`StockMovement`** audit ledger (today `reasonCode` lives only on the event +
logs), and the **concurrent-oversell enforcement** of the `version` column (the
column ships now but no guard consumes it yet). `StockLevel` deliberately exposes
only `changeOnHand`.

## Known gaps / deferrals (carried + observed)

- **Reservation / allocation / commit-sale / cancel / restock / transfer +
  `StockMovement` audit + `version` no-oversell enforcement** → the later
  inventory-reservation / audit-log capability.
- **Reserved-surface events with no consumer yet:** `inventory.stock.received`,
  `inventory.stock.adjusted`, `inventory.stock-level.initialized` (all on
  `inventory_queue`); `catalog.product.{published,archived}`,
  `catalog.price.{changed,scheduled}` (on `catalog_queue`).
- **`ProductStockActionEnum`** (in
  `libs/contracts/inventory/product-stock/product-stock.types.ts`) is still dead
  exported code — inherited from task-01, out of scope here; a candidate for a
  later contracts cleanup.
- **`README.md` observability log sample** (the `PUT /api/order/1/confirm`
  correlated-log JSON, ~line 671) still narrates a successful inventory
  stock-reservation via `ReserveStockForOrderUseCase`. That use case was removed
  and `inventory.order.confirm` is now a deprecation stub, so the sample is an
  illustrative-but-dated happy path. **Left untouched** — it is in the
  observability section (out of this capability's scope), the carryovers never
  scoped it, and rewriting it well means inventing a new representative
  cross-service flow. Flagged here for a future observability-docs pass.
- **`CLAUDE.md` is locally git-excluded** on this clone via
  `.git/info/exclude` (line 11) and is untracked (`git ls-files` does not know
  it). The file is updated **on disk** (which satisfies the deliverable and the
  self-containment grep, both of which read the working tree), but it will **not**
  appear in `git status`/commits here. This is a pre-existing clone condition, not
  introduced this session; I did not `git add -f` it (respecting the local exclude
  and the commit-only-when-asked rule). A maintainer who wants it committed must
  remove the exclude line and `git add CLAUDE.md` deliberately.

## Files added / modified

**Added:**
`docs/implementation/04-inventory-stock-level-and-location/08-inventory-http-file.md`.

**Modified:**
`README.md` (system diagram inventory + catalog boxes; inventory-microservice
layout tree; the whole Caching section; the catalog overview `product_stock`
correction; the seed section's new `stock_level` table; the TTL Role text),
`CLAUDE.md` (Service-Structure ADR ref; the inventory module bullet; the cache
shared-lib bullet; next-free-ADR `028`; the operational cache-aside bullet),
`spec/architecture-lint.spec.ts` (+1 consumer cross-app fixture).

**Deleted:** none.

## How to verify (all run green this session)

```bash
yarn lint                 # exit 0 (--max-warnings 0)
yarn test:unit            # 71 suites, 507 tests pass (was 71/506 in task-05; +1: the consumer arch-lint fixture)
yarn test:e2e             # reload + migrate + seed + 11 suites / 94 tests pass (unchanged from task-05 — no behaviour change)
grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md   # CLEAN (exit 1)

# Full live walkthrough (infra was already healthy this session):
docker compose up -d && yarn migration:run && yarn test:seed && yarn start:dev
# then drive http/inventory.http: login → listLocations → getVariantStockAllLocations
#   → getVariantStockFiltered → receiveStock (50 → 150) → adjustStock (−3 → 147)
#   → adjustStockBelowZero (→ 409)
redis-cli --scan 'ris:inventory:stock:v2:*'    # ris:inventory:stock:v2:1:__all__ after a read
```

The capability is complete; docs `01`–`08`, `README.md`, and `CLAUDE.md` all
describe the live `StockLevel`/`StockLocation` model, and no orchestration
references leak into the tree.
