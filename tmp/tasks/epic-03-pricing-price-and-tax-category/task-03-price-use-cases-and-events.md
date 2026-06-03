---
epic: epic-03
task_number: 3
title: Set / Schedule / Select Applicable Price use cases + events + price RPCs
depends_on: [1, 2]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/05-select-applicable-price.md
adr_deliverable: none
---

# Task 03 — Set / Schedule / Select Applicable Price use cases + events + price RPCs

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-008** (dotted routing keys; `ROUTING_KEYS` is the idiomatic
surface, the legacy `MicroserviceMessagePatternEnum` is kept value-for-value in
lock-step — `routing-keys.constants.spec.ts` enforces it), **ADR-011 / ADR-020**
(cross-service events are plain framework-free interfaces extending
`ICorrelationPayload` + `occurredAt: string`; never serialize a `DomainEvent`;
`ClientProxy` lives only in `infrastructure/messaging/*-rabbitmq.publisher.ts`;
post-commit publish failures are warn-logged and swallowed), **ADR-001** (log
`correlationId` inline inside RPC handlers — `assign()` throws outside request
scope), **ADR-016 / ADR-022** (the reserved `catalogPrice*` cache-key builder +
version constant), and **ADR-026** (the ledger model + the resolution rule you
realize here).

## Goal

Implement the pricing write/read application layer and its RPC surface: Set Price
(immediate) and Schedule Price (future `validFrom`) through one `SetPriceUseCase`;
the in-effect list; and Select Applicable Price (the deterministic
`(variantId, currency, asOf)` → single Price answer used later by cart/order
snapshots and the publish precondition). Emit `catalog.price.changed` /
`catalog.price.scheduled`, expose the three price RPCs on the existing
`catalog_queue`, register the routing keys, and add the reserved
`catalogPrice*` cache-key builder.

## Entry state assumed

- task-01 + task-02 carryover present. The `Price`/`TaxCategory` models,
  `PricingErrorCodeEnum` + `PricingDomainException`, `IPricingRepositoryPort`
  (`findOpenPrice`, `appendPrice`, `findInEffect`, the tax read methods) +
  `PRICING_REPOSITORY`, the entities/mappers/`PricingTypeormRepository`, and the
  migration are on disk. `pricing.module.ts` binds `PRICING_REPOSITORY`.
- No pricing use case, event, routing key, contract DTO, or controller exists yet.
- The catalog module shows the seam to mirror: `CatalogRabbitmqPublisher`
  (`ClientProxy` + `firstValueFrom`, the only messaging file), the use cases that
  drain a domain event and map it to a versioned `v1` wire event, the
  `CatalogController` `@MessagePattern` handlers, and `CatalogRpcExceptionFilter`
  (`APP_FILTER`, maps a typed error code → HTTP status).
- `libs/cache/cache-keys.ts` has the reserved `catalogProduct*` builder +
  `CATALOG_PRODUCT_KEY_VERSION` to mirror.

## Scope

**In**
- Contracts in `libs/contracts/catalog/`: `IPriceSetPayload`, the price
  query interface(s), `PriceView`, `ICatalogPriceChangedEvent`,
  `ICatalogPriceScheduledEvent` (+ barrels).
- Routing keys `catalog.price.set`, `catalog.price.list`, `catalog.price.select`,
  `catalog.price.changed`, `catalog.price.scheduled` in **both**
  `ROUTING_KEYS` and `MicroserviceMessagePatternEnum`.
- `pricing/application/use-cases/`: `SetPriceUseCase`, `ListPricesUseCase`,
  `SelectApplicablePriceUseCase` + their specs.
- `pricing/application/ports/`: `IPricingEventsPublisherPort` +
  `PRICING_EVENTS_PUBLISHER`.
- `pricing/infrastructure/messaging/pricing-rabbitmq.publisher.ts`.
- `pricing/presentation/`: `PricingController` (3 price `@MessagePattern`s) +
  `PricingRpcExceptionFilter`.
- `pricing.module.ts` wiring; `libs/cache/cache-keys.ts` reserved `catalogPrice*`.
- Doc `05-select-applicable-price.md`.

**Out**
- TaxCategory use cases + variant attach + their RPCs (task-04).
- The publish hard-fail (task-05); gateway endpoints (task-06); `.http` (task-07);
  seed rows (task-08).
- Wiring an actual cache on the read path — the `catalogPrice*` builder is
  **reserved/unconsumed** (the threshold for caching pricing is unmet); pricing
  does **not** import `CacheModule`.

## Contract shapes (`libs/contracts/catalog/`)

Framework-free; events extend `ICorrelationPayload` + `occurredAt: string`;
timestamps cross the wire as ISO-8601 strings.

```ts
// interfaces/price-set.interface.ts
export interface IPriceSetPayload extends ICorrelationPayload {
  variantId: number;
  currency: string;       // ISO-4217 3-char
  amountMinor: number;    // integer minor units, >= 0
  validFrom?: string;     // ISO; omitted => now (immediate Set)
  validTo?: string | null;
  priority?: number;      // default 0
}

// interfaces/price-query.interface.ts  (shared by list + select)
export interface IPriceQuery extends ICorrelationPayload {
  variantId: number;
  currency: string;
  asOf?: string;          // ISO; omitted => now
}

// dto/price.view.ts — a CLASS with @ApiResponseProperty (the response-view
// convention in lib-contracts, mirroring ProductView), NOT an interface, so the
// gateway can use it as @ApiOkResponse({ type: PriceView }). @nestjs/swagger is
// the documented lib-contracts exception (ADR-017).
export class PriceView {
  @ApiResponseProperty() public id: number;
  @ApiResponseProperty() public variantId: number;
  @ApiResponseProperty() public currency: string;
  @ApiResponseProperty() public amountMinor: number;
  @ApiResponseProperty() public validFrom: string;        // ISO
  @ApiResponseProperty() public validTo: string | null;   // ISO or null (open-ended)
  @ApiResponseProperty() public priority: number;
}

// events/price-changed.event.ts
export interface ICatalogPriceChangedEvent extends ICorrelationPayload {
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom: string;
  validTo: string | null;
  priority: number;
  eventVersion: 'v1';
  occurredAt: string;
}

// events/price-scheduled.event.ts  (PriceChanged + effectiveAt)
export interface ICatalogPriceScheduledEvent extends ICatalogPriceChangedEvent {
  effectiveAt: string;    // ISO; == validFrom for a scheduled (future) price
}
```

`SelectApplicablePriceUseCase` returns `PriceView | null`; `ListPricesUseCase`
returns `PriceView[]`.

## Use-case behavior

**`SetPriceUseCase`** (handles both Set and Schedule — one RPC `catalog.price.set`,
one endpoint later):
1. Build `Price.set({ variantId, currency, amountMinor, validFrom, validTo,
   priority })` from the payload (`validFrom` omitted ⇒ now). The domain rejects a
   past `validFrom`, a bad currency/amount, and an inverted interval.
2. `const open = await repo.findOpenPrice(variantId, currency)`.
3. Compute the predecessor to close:
   - `open === null` ⇒ `predecessorToClose = null` (first price for the scope).
   - `open.validFrom < newPrice.validFrom` ⇒ `predecessorToClose =
     open.close(newPrice.validFrom)` (the current open price ends exactly when the
     new one starts — this is what makes scheduling leave the current answer
     unchanged until `validFrom`).
   - otherwise (`open.validFrom >= newPrice.validFrom`) ⇒ reject with a typed
     `PRICE_SCHEDULE_CONFLICT` (a new row cannot start at or before the existing
     open row; there is no cancel/reschedule flow in this capability — document
     the limitation).
4. `const saved = await repo.appendPrice(newPrice, predecessorToClose)` (atomic
   close+insert, returns the row with its concrete id).
5. Post-commit, best-effort: if `newPrice.validFrom > now` emit
   `catalog.price.scheduled` (`effectiveAt = validFrom`), else
   `catalog.price.changed`. A publish failure is warn-logged and swallowed (the
   row is already persisted, ADR-020).
6. Return `PriceView` of `saved`.

**`SelectApplicablePriceUseCase`** (`catalog.price.select`, and backs the GET
single-price endpoint + the publish precondition):
1. `asOf` defaults to now.
2. `const candidates = await repo.findInEffect(variantId, currency, asOf)`.
3. Resolve: sort by `priority` DESC, then `validFrom` DESC; return the first as a
   `PriceView`, or `null` if none. **The resolution lives here (not in SQL)** so
   it is unit-testable with an in-memory repository double.

**`ListPricesUseCase`** (`catalog.price.list`): `repo.findInEffect(...)` mapped to
`PriceView[]` (every row in effect for the query, defaulting `currency`/`asOf`
handled at the gateway DTO level later).

> A small private view factory (mirror `catalog-view.factory.ts`) maps a domain
> `Price` → `PriceView` (Dates → ISO strings). Keep it in `application/use-cases/`.

## Events publisher

`IPricingEventsPublisherPort` (+ `PRICING_EVENTS_PUBLISHER`):
`publishPriceChanged(event, correlationId?)` and `publishPriceScheduled(event,
correlationId?)`. `PricingRabbitmqPublisher` is the **only** pricing file that
imports `ClientProxy`; it injects the `catalog_queue` client
(`MicroserviceClientTokenEnum.CATALOG_MICROSERVICE`, provided by
`MicroserviceClientCatalogModule`) and emits via `firstValueFrom(client.emit(...))`
— exactly as `CatalogRabbitmqPublisher` does. The price events ride `catalog_queue`
with no cross-service consumer yet (a later audit/event-store capability binds
`catalog.price.changed`).

## Cache-key builder (reserved)

In `libs/cache/cache-keys.ts`, mirror the reserved `catalogProduct*` block:
`const CATALOG_PRICE_KEY_VERSION = 'v1';` and

```ts
catalogPricePrefix: (variantId: number, opts?: ITenantOptions): string =>
  `${rootPrefix(opts)}catalog:price:${CATALOG_PRICE_KEY_VERSION}:${variantId}:`,
catalogPrice: (variantId: number, currency: string, opts?: ITenantOptions): string =>
  `${CACHE_KEYS.catalogPricePrefix(variantId, opts)}${currency}`,
```

Key shape `ris:[t:<tenantId>:]catalog:price:v1:<variantId>:<currency>`. Add the
same "reserved / not consumed yet — pricing does not import `CacheModule`" comment
the `catalogProduct*` block carries. A bump of `CATALOG_PRICE_KEY_VERSION`
re-keys on next deploy (ADR-022).

## Files to add

- `libs/contracts/catalog/interfaces/price-set.interface.ts`
- `libs/contracts/catalog/interfaces/price-query.interface.ts`
- `libs/contracts/catalog/dto/price.view.ts`
- `libs/contracts/catalog/events/price-changed.event.ts`
- `libs/contracts/catalog/events/price-scheduled.event.ts`
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/set-price.use-case.ts`
- `.../use-cases/list-prices.use-case.ts`
- `.../use-cases/select-applicable-price.use-case.ts`
- `.../use-cases/price-view.factory.ts`
- `.../use-cases/spec/set-price.use-case.spec.ts`
- `.../use-cases/spec/schedule-price.use-case.spec.ts`
- `.../use-cases/spec/select-applicable-price.use-case.spec.ts`
- `.../use-cases/spec/test-doubles.ts` (in-memory `IPricingRepositoryPort` +
  `IPricingEventsPublisherPort` doubles — mirror the catalog `test-doubles.ts`)
- `apps/catalog-microservice/src/modules/pricing/application/ports/pricing-events.publisher.port.ts`
- `apps/catalog-microservice/src/modules/pricing/infrastructure/messaging/pricing-rabbitmq.publisher.ts`
- `apps/catalog-microservice/src/modules/pricing/presentation/pricing.controller.ts`
- `apps/catalog-microservice/src/modules/pricing/presentation/pricing-rpc-exception.filter.ts`
- `apps/catalog-microservice/src/modules/pricing/presentation/spec/pricing-rpc-exception.filter.spec.ts` (mirror catalog)
- `docs/implementation/03-pricing-price-and-tax-category/05-select-applicable-price.md`

## Files to modify

- `libs/messaging/routing-keys.constants.ts` — add the five `CATALOG_PRICE_*` keys.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` — add the
  same five (keep value-for-value; `routing-keys.constants.spec.ts` asserts it).
- `libs/contracts/catalog/{interfaces,dto,events}/index.ts` — barrel the new types.
- `libs/cache/cache-keys.ts` — add the reserved `catalogPrice*` builder + version.
- `apps/catalog-microservice/src/modules/pricing/application/{ports,use-cases}/index.ts`,
  `infrastructure/messaging/index.ts`, `presentation/index.ts` — barrels.
- `apps/catalog-microservice/src/modules/pricing/pricing.module.ts` — import
  `MicroserviceClientCatalogModule`; add the three use cases, the publisher +
  `{ provide: PRICING_EVENTS_PUBLISHER, useExisting: PricingRabbitmqPublisher }`,
  `PricingController`, and `{ provide: APP_FILTER, useClass:
  PricingRpcExceptionFilter }`.

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`):
  - `set-price.use-case.spec.ts` — immediate Set: opens a new Price; with an open
    predecessor (past `validFrom`) closes its `valid_to` to the new `valid_from`;
    emits `catalog.price.changed`; first-price-for-scope case (no predecessor);
    `PRICE_SCHEDULE_CONFLICT` when the open row starts at/after the new row;
    best-effort: a publisher rejection still returns the view (warn-logged).
  - `schedule-price.use-case.spec.ts` — `validFrom > now`: emits
    `catalog.price.scheduled` with `effectiveAt == validFrom`; the predecessor is
    closed at the future `validFrom`; a `SelectApplicable(asOf=now)` against the
    resulting rows still returns the current price, while `asOf` after `validFrom`
    returns the scheduled one (assert against the double's resulting row set).
  - `select-applicable-price.use-case.spec.ts` — resolution by `priority` DESC
    then `validFrom` DESC; the tiebreak; `asOf` interval containment; returns
    `null` when no row is in scope.
- **Filter spec** — mirror `catalog-rpc-exception.filter.spec.ts`
  (`PRICE_SCHEDULE_CONFLICT` → 409, validation codes → 400, not-found → 404).
- `yarn test:e2e` still passes (no gateway route yet; the new RPCs have no HTTP
  caller until task-06).

## Doc deliverable

`05-select-applicable-price.md` — the resolution algorithm (interval containment
+ `priority` DESC, `validFrom` DESC tiebreak), worked fixtures (overlapping
priorities; a scheduled future row; an empty result → `null`), why resolution
lives in the use case rather than SQL (unit-testability), and how Set vs Schedule
share one use case/RPC and differ only by `validFrom` and the emitted event.

## Carryover to read

`carryover-01.md`, `carryover-02.md`.

## Carryover to produce

Write `carryover-03.md`. Capture: the five routing keys + that both
`ROUTING_KEYS` and `MicroserviceMessagePatternEnum` carry them; the contract
type names + field shapes; `IPricingEventsPublisherPort` + the
`PRICING_EVENTS_PUBLISHER` symbol; the use-case names + the `SetPriceUseCase`
close/conflict rule; the `PricingController` `@MessagePattern`s now live; the
reserved `catalogPrice*` builder; that `select-applicable` is the seam task-05's
publish hard-fail consumes. List the gaps (tax use cases/attach → task-04;
publish hard-fail → task-05; gateway → task-06). Verify commands.

## Exit criteria

- [ ] The three price RPCs (`catalog.price.set/list/select`) are handled by
      `PricingController`; the two price events are emitted by
      `PricingRabbitmqPublisher` (the only `ClientProxy` file in pricing).
- [ ] Routing keys exist in both `ROUTING_KEYS` and
      `MicroserviceMessagePatternEnum`; `routing-keys.constants.spec.ts` is green.
- [ ] `SetPriceUseCase` (Set + Schedule), `ListPricesUseCase`,
      `SelectApplicablePriceUseCase` exist with the documented behavior.
- [ ] The reserved `catalogPrice*` builder + `CATALOG_PRICE_KEY_VERSION` exist;
      pricing does **not** import `CacheModule`.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the three new use-case specs + the filter spec are
      green.
- [ ] `yarn test:e2e` passes.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots the
      catalog service; the new price RPC handlers register on `catalog_queue`.
- [ ] `05-select-applicable-price.md` is written.
- [ ] The self-containment grep is clean.
- [ ] `carryover-03.md` is written.
