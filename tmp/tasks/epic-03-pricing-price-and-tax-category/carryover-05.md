# Carryover 05 — Publish Product hard-fails on a missing active Price

State handed forward from task-05 to task-06 (and beyond). Read this before
touching the catalog/pricing modules. (Read `carryover-01.md` … `carryover-04.md`
first.)

## Entry state for task-06

The catalog `PublishProductUseCase` now **hard-fails** the publish when any
variant lacks an in-effect Price in the default currency. The check lives in the
catalog module (a use-case rule, not a domain rule), reading the pricing-owned
`price` table by parameterized query — the catalog module still imports **nothing**
from the pricing module. lint / unit / e2e all green.

What is now wired on top of task-04:

- **`application/ports/active-price-probe.port.ts`** (new) — `IActivePriceProbePort`
  + `ACTIVE_PRICE_PROBE` symbol, **plus** the `CATALOG_DEFAULT_CURRENCY` string
  token (colocated in the same file). The `application/ports/index.ts` barrel
  exports it.
  ```ts
  export const ACTIVE_PRICE_PROBE = Symbol('ACTIVE_PRICE_PROBE');
  export interface IActivePriceProbePort {
    findVariantsMissingActivePrice(variantIds: number[], currency: string): Promise<number[]>;
  }
  export const CATALOG_DEFAULT_CURRENCY = Symbol('CATALOG_DEFAULT_CURRENCY');
  ```
- **`infrastructure/persistence/active-price-probe.typeorm.adapter.ts`** (new) —
  `ActivePriceProbeTypeormAdapter implements IActivePriceProbePort`. Injects the
  catalog `ProductVariantEntity` repository **only for its shared
  `EntityManager`** and runs ONE parameterized read against the `price` table
  (the query targets `price`, never the variant table; no pricing import):
  ```sql
  SELECT DISTINCT variant_id AS variantId
    FROM price
   WHERE variant_id IN (?, ?, …)   -- one `?` per id, built from array length
     AND currency = ?
     AND valid_from <= UTC_TIMESTAMP()
     AND (valid_to IS NULL OR valid_to > UTC_TIMESTAMP())
  ```
  Diffs the requested ids against the priced set; coerces the (possibly
  string) BIGINT `variant_id` with `Number(...)`. **Empty input → `[]` with no
  query** (an empty `IN ()` is a MySQL syntax error). The `infrastructure/
  persistence/index.ts` barrel exports it. This is the symmetric mirror of
  pricing's parameterized write of `product_variant.tax_category_id` (ADR-017 /
  ADR-026 §5).
- **`application/use-cases/publish-product.use-case.ts`** — injects
  `ACTIVE_PRICE_PROBE` + `CATALOG_DEFAULT_CURRENCY` (constructor order:
  repository, publisher, **priceProbe, defaultCurrency**, logger). After the
  not-found check and **before** `product.publish()`: collect the variant ids,
  `findVariantsMissingActivePrice(ids, defaultCurrency)`, and throw
  `PRODUCT_PUBLISH_REQUIRES_PRICE` if any are missing (nothing persisted, no
  event). Order matters: a variant-less product yields an empty id list (probe
  no-op) and still fails on the domain's `PRODUCT_PUBLISH_REQUIRES_VARIANT`.
- **`domain/catalog.exception.ts`** — added
  `CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_PRICE =
  'CATALOG_PRODUCT_PUBLISH_REQUIRES_PRICE'`.
- **`presentation/catalog-rpc-exception.filter.ts`** — maps the new code → **409**
  (joins the illegal-state/conflict group). The `Record<CatalogErrorCodeEnum,
  HttpStatus>` stays total (compile-time exhaustive).
- **`catalog.module.ts`** — binds `ACTIVE_PRICE_PROBE` →
  `ActivePriceProbeTypeormAdapter` (`useExisting`) and
  `CATALOG_DEFAULT_CURRENCY` via a `useFactory` reading
  `ConfigService.get('DEFAULT_CURRENCY') ?? 'USD'` (`inject: [ConfigService]`;
  `ConfigModule` is global, no per-module import needed).

`pricing.module.ts`, the pricing domain/persistence/use-cases, and all routing
keys/contracts are **unchanged** — the hard-fail is entirely catalog-side. No
migration, no new routing key, no new contract DTO.

## Config

`libs/config/config-module.config.ts` Joi schema gained:
```ts
DEFAULT_CURRENCY: Joi.string().length(3).uppercase().default('USD'),
```
Because it defaults, a missing var never fails boot. Added explicitly to
`docker-compose.yml` (catalog service `environment:` block), `.env.example`, and
`.env.local`. **The README env-var table row is NOT yet added → task-08.**

## How the 409 reaches HTTP

No gateway change was needed — the existing `POST
/api/catalog/products/:productId/publish` route already surfaces the wire error's
`statusCode` (the `CatalogRpcExceptionFilter` emits `{ statusCode, message, code
}`), so a `PRODUCT_PUBLISH_REQUIRES_PRICE` rejection propagates as a real 409.

## Deviation worth respecting (e2e)

task-05's brief assumed the catalog e2e never publishes via the live flow ("the
seed inserts products as `active` via SQL, bypassing publish"). **That was
incomplete** — `test/catalog.e2e-spec.ts` runs a live `register → add variants →
publish → archive` flow, so the hard-fail broke it. Fix applied (start-from-
scratch latitude):

- New helper **`test/data-source/catalog.e2e-spec.data-source.ts`**
  (`CatalogE2ESpecDataSource extends DataSource`, mirrors
  `system-api.e2e-spec.data-source.ts`) with
  `insertActivePrice(variantId, currency, amountMinor)` → a parameterized
  `INSERT INTO price (variant_id, currency, amount_minor, valid_from) VALUES (?,
  ?, ?, UTC_TIMESTAMP())` (open row: `valid_to` NULL, `priority`/timestamps
  defaulted, `open_scope_key` generated).
- `catalog.e2e-spec.ts` now initializes that DataSource in `beforeAll`
  (`new ...({ type: 'mysql', url: process.env.DATABASE_URL! })` + `.initialize()`),
  destroys it in `afterAll`, and adds a step **"gives each variant an active USD
  price so the publish precondition is met"** between "appends two variants" and
  "publishes" — seeding one open USD price per variant via SQL (the only
  price-write path until the gateway pricing routes land in task-06).

This was a **SQL seed of prices**, deliberately not the real pricing RPC, because
no HTTP/RMQ price-write caller exists in this e2e yet. task-06 may choose to drive
prices through the new gateway pricing route instead.

## Known gaps / deferrals (each owned by a later task)

- **Gateway pricing + tax endpoints** → **task-06** (the HTTP surface fronting all
  six pricing RPCs, `pricing:write`-gated). **Also task-06's:** the end-to-end
  proof of the **publish-with-no-price 409** through the gateway (and any
  concurrency test) — the unit spec here proves the use-case behavior with a probe
  double; the live 409 is task-06's. task-06 creates its own draft product with no
  price to drive it.
- **`http/pricing.http`** → **task-07**.
- **README `DEFAULT_CURRENCY` env-var row + price/tax seed rows + finalization** →
  **task-08**. The `tax_category` table is still empty; the catalog e2e seeds its
  own prices inline (above), so no shared seed change was made here.

## How to verify (all run green at end of task-05)

- `yarn lint` — exit 0 (`--max-warnings 0`). No boundary violations; the catalog
  module imports nothing from `modules/pricing` (the `price` read is parameterized
  SQL through the catalog variant repo's manager).
- `yarn format:check` — clean.
- `yarn build:catalog-microservice` — exit 0 (the new providers + token type-check).
- `yarn test:unit` — **475 tests / 68 suites** pass (+6 since task-04: 5
  `active-price-probe.typeorm.adapter.spec.ts` cases + 1 net new publish-spec test;
  the filter spec adds the new code to its existing 409-group loop).
- `yarn test:e2e` — **76 tests / 6 suites** pass on a fresh infra reload + migrate
  + seed (+1 since task-04: the new "gives each variant an active USD price" step;
  the catalog publish flow now seeds prices before publishing).
  - Targeted re-run against running infra:
    `yarn test:e2e:run --testPathPattern catalog`.
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`
  → no orchestration references.

## Files added

- `apps/catalog-microservice/src/modules/catalog/application/ports/active-price-probe.port.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/active-price-probe.typeorm.adapter.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/spec/active-price-probe.typeorm.adapter.spec.ts`
- `test/data-source/catalog.e2e-spec.data-source.ts`
- `docs/implementation/03-pricing-price-and-tax-category/04-publish-precondition-hard-fail.md`
- `tmp/tasks/epic-03-pricing-price-and-tax-category/carryover-05.md` (this file)

## Files modified

- `apps/catalog-microservice/src/modules/catalog/application/ports/index.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/test-doubles.ts`
  (added `InMemoryActivePriceProbe`)
- `apps/catalog-microservice/src/modules/catalog/domain/catalog.exception.ts`
- `apps/catalog-microservice/src/modules/catalog/domain/product.model.ts`
  (updated the stale `publish()` comment — the price check now hard-fails in the
  use case, not "warn, not block")
- `apps/catalog-microservice/src/modules/catalog/infrastructure/persistence/index.ts`
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog-rpc-exception.filter.ts`
- `apps/catalog-microservice/src/modules/catalog/presentation/spec/catalog-rpc-exception.filter.spec.ts`
- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts`
- `libs/config/config-module.config.ts`
- `docker-compose.yml`, `.env.example`, `.env.local`
- `test/catalog.e2e-spec.ts`
- `CLAUDE.md`
- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md`
- `docs/implementation/02-catalog-product-and-variant/03-product-and-variant-domain.md`

## Files deleted

- None. (task-01 already removed the warn-and-proceed placeholder.)
