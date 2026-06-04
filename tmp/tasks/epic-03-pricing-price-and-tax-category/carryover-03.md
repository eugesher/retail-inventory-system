# Carryover 03 — Price use cases + events + price RPCs

State handed forward from task-03 to task-04 (and beyond). Read this before
touching the pricing module. (Read `carryover-01.md` and `carryover-02.md` first.)

## Entry state for task-04

The pricing module now has its full **price** write/read application layer and RPC
surface on disk under `apps/catalog-microservice/src/modules/pricing/`. The
catalog service boots clean as an RMQ server on `catalog_queue` and the three new
price RPC handlers register (verified — see "How to verify"). e2e is green.

What is now wired (on top of task-02's domain/persistence):

- **`application/ports/`** — added `IPricingEventsPublisherPort` +
  `PRICING_EVENTS_PUBLISHER` symbol (`pricing-events.publisher.port.ts`). The
  `application/ports/index.ts` barrel exports both ports.
- **`application/use-cases/`** — `SetPriceUseCase`, `ListPricesUseCase`,
  `SelectApplicablePriceUseCase`, and a shared `price-view.factory.ts`
  (`toPriceView`). Barrel exports the three use cases.
- **`infrastructure/messaging/`** — `PricingRabbitmqPublisher` (the **only**
  `ClientProxy` site in pricing; injects the `catalog_queue` client via
  `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE`; emits
  `catalog.price.changed` / `catalog.price.scheduled` via
  `firstValueFrom(client.emit(...))`). Barrel exports it.
- **`presentation/`** — `PricingController` (three `@MessagePattern`s) +
  `PricingRpcExceptionFilter` (`@Catch(PricingDomainException)`, maps
  `PricingErrorCodeEnum` → HTTP status). Barrel exports both.
- **`pricing.module.ts`** — now imports `MicroserviceClientCatalogModule`;
  registers `PricingController`; binds `PRICING_EVENTS_PUBLISHER` →
  `PricingRabbitmqPublisher` (`useExisting`); registers the three use cases and
  `{ provide: APP_FILTER, useClass: PricingRpcExceptionFilter }`. Still **no**
  `CacheModule`.

`app/app.module.ts` is **unchanged** (it already imports `PricingModule`).

## Routing keys (five, in BOTH places, value-for-value)

Added to `libs/messaging/routing-keys.constants.ts` (`ROUTING_KEYS`) **and**
`libs/contracts/microservices/microservice-message-pattern.enum.ts`
(`MicroserviceMessagePatternEnum`); `routing-keys.constants.spec.ts` asserts the
alignment (and the `uses dotted naming convention` test covers them):

| Key (member) | Wire value | Kind |
| --- | --- | --- |
| `CATALOG_PRICE_SET` | `catalog.price.set` | RPC |
| `CATALOG_PRICE_LIST` | `catalog.price.list` | RPC |
| `CATALOG_PRICE_SELECT` | `catalog.price.select` | RPC |
| `CATALOG_PRICE_CHANGED` | `catalog.price.changed` | event (no consumer yet) |
| `CATALOG_PRICE_SCHEDULED` | `catalog.price.scheduled` | event (no consumer yet) |

## Contracts (`libs/contracts/catalog/`, barrels updated)

- `interfaces/price-set.interface.ts` — **`IPriceSetPayload`** extends
  `ICorrelationPayload`: `variantId: number`, `currency: string`,
  `amountMinor: number`, `validFrom?: string`, `validTo?: string | null`,
  `priority?: number`. (ISO-8601 strings on the wire.)
- `interfaces/price-query.interface.ts` — **`IPriceQuery`** extends
  `ICorrelationPayload`: `variantId: number`, `currency: string`, `asOf?: string`.
  Shared by list + select.
- `dto/price.view.ts` — **`PriceView`** (a **class** with `@ApiResponseProperty`,
  like `ProductView`): `id`, `variantId`, `currency`, `amountMinor`,
  `validFrom: string`, `validTo: string | null`, `priority`.
- `events/price-changed.event.ts` — **`ICatalogPriceChangedEvent`** extends
  `ICorrelationPayload`: `variantId`, `currency`, `amountMinor`, `validFrom`,
  `validTo: string | null`, `priority`, `eventVersion: 'v1'`, `occurredAt`.
- `events/price-scheduled.event.ts` — **`ICatalogPriceScheduledEvent`** extends
  `ICatalogPriceChangedEvent` + `effectiveAt: string` (== `validFrom`).

## Use-case behavior (the close/conflict rule task-05 must respect)

- **`SetPriceUseCase` (Set + Schedule, one RPC `catalog.price.set`)**: builds
  `Price.set(...)` with a single captured `now`; `findOpenPrice(variantId,
  currency)`; then `resolvePredecessor(open, newPrice)`:
  - `open === null` → no predecessor (first price for the scope).
  - `open.validFrom < newPrice.validFrom` → `open.close(newPrice.validFrom)`
    (close the predecessor exactly at the new start — tiles half-open intervals;
    this is what keeps the current answer unchanged until a future `validFrom`).
  - `open.validFrom >= newPrice.validFrom` → throw
    **`PRICE_SCHEDULE_CONFLICT`** (new typed code; no cancel/reschedule flow).
  Then `appendPrice(newPrice, predecessorToClose)`; **post-commit best-effort**:
  `saved.validFrom > now` → `publishPriceScheduled` (`effectiveAt = validFrom`),
  else `publishPriceChanged`. A publish rejection is warn-logged and swallowed.
  Returns `PriceView`.
- **`SelectApplicablePriceUseCase` (`catalog.price.select`)**: `asOf` defaults to
  now; `findInEffect(...)` (coarse interval-containment set); resolves via the
  **pure static** `SelectApplicablePriceUseCase.resolve(candidates)` = sort by
  `priority` DESC then `validFrom` DESC, pick first, or `null`. **This is the seam
  task-05's publish hard-fail consumes** — call it for `(variantId, currency, now)`
  and block publish when it returns `null`.
- **`ListPricesUseCase` (`catalog.price.list`)**: `findInEffect(...)` mapped to
  `PriceView[]` (no collapse).

## New typed code

`PricingErrorCodeEnum.PRICE_SCHEDULE_CONFLICT = 'PRICING_PRICE_SCHEDULE_CONFLICT'`
(added in `domain/pricing.exception.ts`). The filter maps it → **409**;
`TAX_CATEGORY_CODE_TAKEN` → 409; `TAX_CATEGORY_NOT_FOUND` / `VARIANT_NOT_FOUND` →
404; all the `*_INVALID` / `*_REQUIRED` / `*_IN_PAST` codes → 400. The filter's
`Record<PricingErrorCodeEnum, HttpStatus>` is **total** — task-04 adding a tax code
that is already in the enum needs no filter change, but a brand-new code does.

## PricingController `@MessagePattern`s (now live on `catalog_queue`)

`presentation/pricing.controller.ts`:
`CATALOG_PRICE_SET` → `SetPriceUseCase`, `CATALOG_PRICE_LIST` →
`ListPricesUseCase`, `CATALOG_PRICE_SELECT` → `SelectApplicablePriceUseCase`.

## Reserved cache-key builder (NOT consumed)

`libs/cache/cache-keys.ts` gained `CATALOG_PRICE_KEY_VERSION = 'v1'` and
`catalogPricePrefix(variantId, opts?)` / `catalogPrice(variantId, currency,
opts?)` → `ris:[t:<tenantId>:]catalog:price:v1:<variantId>:<currency>`. Mirrors the
reserved `catalogProduct*` block; `cache-keys.spec.ts` locks the shape. The pricing
module does **not** import `CacheModule` — the builder is reserved/unconsumed.

## Test doubles (reusable by task-04)

`application/use-cases/spec/test-doubles.ts` — `InMemoryPricingRepository`
(implements the **full** `IPricingRepositoryPort`, including the tax read/write
methods, as a real append-only ledger; `findInEffect` returns candidates
**unsorted** so the use case's resolution is what the select spec proves) +
`InMemoryPricingEventsPublisher`.

## Known gaps / deferrals (each owned by a later task)

- **Tax-category use cases (create/list) + variant attach** (the
  `attachTaxCategoryToVariant` + variant-tax-header read method on
  `IPricingRepositoryPort`, the attach use case, its RPC/routing keys, the tax
  contracts) → **task-04**. The repo already has `createTaxCategory` /
  `listTaxCategories` / `findTaxCategoryByCode`; the `tax_category_id` FK exists.
- **Publish hard-fail** (publish blocks a price-less product) → **task-05**, via
  `SelectApplicablePriceUseCase` (the seam above). task-03 added no price check to
  catalog's `PublishProductUseCase`.
- **Gateway pricing endpoints** → **task-06**; **`http/pricing.http`** →
  **task-07**; **price/tax seed rows + finalization** → **task-08**. No gateway
  route, `.http` file, or seed change in task-03 (the price RPCs have no HTTP
  caller until task-06; e2e still green without one).

## How to verify (all run green at end of task-03)

- `yarn lint` — exit 0 (`--max-warnings 0`).
- `yarn test:unit` — **455 tests / 64 suites** pass (20 new since task-02: three
  `catalogPrice` cache-key cases plus the `set-price` (4) / `schedule-price` (3) /
  `select-applicable-price` (5) / `pricing-rpc-exception.filter` (5) specs; the
  five new routing-key assertions extend the existing alignment test rather than
  adding cases).
- `yarn build` — exit 0.
- `yarn test:e2e` — **75 tests / 6 suites** pass on a fresh infra reload + migrate
  + seed (no new gateway route; the price RPCs have no HTTP caller yet).
- Catalog boots + price handlers register: with infra up,
  `node dist/apps/catalog-microservice/main.js` (env from `.env.local`) logs
  `Catalog Microservice is listening for messages`, runs `SELECT version()`, and
  shows **no** error/fatal lines or duplicate-pattern errors (a duplicate
  `@MessagePattern` would throw at boot). (`docker compose up -d && yarn
  migration:run && yarn start:dev` is the dev-mode equivalent.)
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`
  → no orchestration references.

## Files added

- `libs/contracts/catalog/interfaces/price-set.interface.ts`
- `libs/contracts/catalog/interfaces/price-query.interface.ts`
- `libs/contracts/catalog/dto/price.view.ts`
- `libs/contracts/catalog/events/price-changed.event.ts`
- `libs/contracts/catalog/events/price-scheduled.event.ts`
- `apps/catalog-microservice/src/modules/pricing/application/ports/pricing-events.publisher.port.ts`
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/set-price.use-case.ts`
- `.../use-cases/list-prices.use-case.ts`
- `.../use-cases/select-applicable-price.use-case.ts`
- `.../use-cases/price-view.factory.ts`
- `.../use-cases/spec/test-doubles.ts`
- `.../use-cases/spec/set-price.use-case.spec.ts`
- `.../use-cases/spec/schedule-price.use-case.spec.ts`
- `.../use-cases/spec/select-applicable-price.use-case.spec.ts`
- `apps/catalog-microservice/src/modules/pricing/infrastructure/messaging/pricing-rabbitmq.publisher.ts`
- `apps/catalog-microservice/src/modules/pricing/presentation/pricing.controller.ts`
- `apps/catalog-microservice/src/modules/pricing/presentation/pricing-rpc-exception.filter.ts`
- `apps/catalog-microservice/src/modules/pricing/presentation/spec/pricing-rpc-exception.filter.spec.ts`
- `docs/implementation/03-pricing-price-and-tax-category/05-select-applicable-price.md`
- `tmp/tasks/epic-03-pricing-price-and-tax-category/carryover-03.md` (this file)

## Files modified

- `libs/messaging/routing-keys.constants.ts`, `libs/messaging/spec/routing-keys.constants.spec.ts`
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`
- `libs/contracts/catalog/{interfaces,dto,events}/index.ts` (barrels)
- `libs/cache/cache-keys.ts`, `libs/cache/spec/cache-keys.spec.ts`
- `apps/catalog-microservice/src/modules/pricing/domain/pricing.exception.ts`
  (added `PRICE_SCHEDULE_CONFLICT`)
- `apps/catalog-microservice/src/modules/pricing/application/ports/index.ts`
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/index.ts`
- `apps/catalog-microservice/src/modules/pricing/infrastructure/messaging/index.ts`
- `apps/catalog-microservice/src/modules/pricing/presentation/index.ts`
- `apps/catalog-microservice/src/modules/pricing/pricing.module.ts`
- `CLAUDE.md`, `README.md`

## Files deleted

- None.
