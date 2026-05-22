---
epic: epic-03
task_number: 3
title: Implement Set Price + Schedule Price + Select Applicable Price use cases, event publisher emission, and RPC message patterns
depends_on: [task-02]
doc_deliverable: docs/implementation/epic-03-pricing-price-and-tax-category/05-select-applicable-price.md
---

# Task 03 — Implement Set Price + Schedule Price + Select Applicable Price use cases

## Goal

Land the three core pricing use cases on top of the domain + repository ports from task-02. After this task, the `catalog-microservice` answers RPC calls on `catalog_queue` for `catalog.price.set`, `catalog.price.schedule`, `catalog.price.select`, `catalog.price.list`, `catalog.tax-category.list`, and `catalog.tax-category.create`. The Set / Schedule paths emit `catalog.price.changed` / `catalog.price.scheduled` events on the message bus. The Select path is the resolution algorithm that downstream consumers (api-gateway read, `Publish Product` precondition in task-04, future `epic-05` cart line snapshot) all call to answer "what is the current price for this variant?"

This task does **not** add HTTP surface — that is task-05. Everything here is internal to `catalog-microservice`: domain logic + event emission + `@MessagePattern` RPC handlers on the existing `catalog_queue` from epic-02.

## Entry state assumed

Task-02 complete. Specifically:

- `Price` and `TaxCategory` domain models exist with their invariants enforced.
- `PriceRepositoryPort` + `TaxCategoryRepositoryPort` + `ClockPort` are registered in `PricingModule` and exported.
- The migration `CreatePriceAndTaxCategoryTables` is on disk; `price` and `tax_category` tables exist; the functional unique index (or the documented fallback) is in place.
- `ProductVariant.taxCategoryId` exists in the domain + DB.
- `ROUTING_KEYS.CATALOG_PRICE_CHANGED` and `ROUTING_KEYS.CATALOG_PRICE_SCHEDULED` are registered in `libs/messaging/routing-keys.constants.ts`.
- The existing catalog `MessagePattern` RPC handlers (`catalog.product.list`, `catalog.product.get`, `catalog.variant.get` — added by epic-02 task-05) live in `apps/catalog-microservice/src/modules/catalog/presentation/`. The new pricing handlers in this task mirror that shape but live under `…/modules/pricing/presentation/`.

## Scope

**In:**

- Three new use cases under `apps/catalog-microservice/src/modules/pricing/application/use-cases/`:
  - `set-price.use-case.ts` — opens a new `Price`; if a predecessor exists with `valid_to IS NULL` in the same `(variantId, currency)` scope, closes it; emits `catalog.price.changed`.
  - `schedule-price.use-case.ts` — same shape but `validFrom > now`; the predecessor's open interval is NOT closed (the future Price coexists with the current open Price; the system trusts the resolution algorithm to pick the right row at read time); emits `catalog.price.scheduled`.
  - `select-applicable-price.use-case.ts` — `(variantId, currency, asOf=now): Promise<Price | null>` — the resolution algorithm; returns `null` when no Price applies.
- Two read-side use cases (thin wrappers over the repository — they exist so the presentation layer never reaches into the repo directly):
  - `list-prices-in-effect.use-case.ts` — backs the `GET /variants/:variantId/prices` endpoint in task-05.
  - `list-tax-categories.use-case.ts` — backs the `GET /tax-categories` endpoint in task-05.
- One TaxCategory write use case:
  - `create-tax-category.use-case.ts` — creates a TaxCategory; the only side effect is the DB insert; no event emitted (the static set is small and its writes are administrative, not part of the order lifecycle audit).
- Variant ↔ TaxCategory attachment (called by `PATCH /variants/:variantId/tax-category` in task-05):
  - `attach-tax-category-to-variant.use-case.ts` — reads the variant from the catalog repo (port-only, no cross-module domain import), reads the TaxCategory by code, mutates the variant via its `attachTaxCategory(id)` model method, persists.
  - **Cross-module discipline**: this use case lives in `pricing/application/use-cases/` and depends on the catalog's `ProductVariantRepositoryPort` (already exported from epic-02's `CatalogModule`). The pricing module imports the **port** (not the domain). Honors task-01's ban: `pricing/domain/**` never imports from `catalog/**`. Verify in the doc.
- Event publisher under `…/modules/pricing/infrastructure/messaging/`:
  - `pricing.event-publisher.ts` — thin adapter that the use cases call to emit `PriceChanged` / `PriceScheduled`. Uses the existing `MessagingModule` / `ClientsModule` wiring (epic-02 task-03 set up the pattern).
  - The interface lives in `…/application/ports/event-publisher.port.ts` so the use cases depend on the port, not the adapter.
- RPC `@MessagePattern` controller(s) under `…/modules/pricing/presentation/`:
  - `pricing.controller.ts` carrying handlers for `catalog.price.set`, `catalog.price.schedule`, `catalog.price.select`, `catalog.price.list`, `catalog.tax-category.list`, `catalog.tax-category.create`, `catalog.variant.attach-tax-category`.
  - The DTO shapes are TypeScript interfaces in `…/application/dto/` (or wherever the existing catalog module places its RPC DTOs — clone the layout). The api-gateway side defines the HTTP DTOs with `class-validator` decorators in task-05; the microservice side speaks plain TypeScript interfaces over the wire.
- Extend `libs/contracts/microservices/microservice-message-pattern.enum.ts` with the new patterns:
  - `CATALOG_PRICE_SET = 'catalog.price.set'`
  - `CATALOG_PRICE_SCHEDULE = 'catalog.price.schedule'`
  - `CATALOG_PRICE_SELECT = 'catalog.price.select'`
  - `CATALOG_PRICE_LIST = 'catalog.price.list'`
  - `CATALOG_TAX_CATEGORY_LIST = 'catalog.tax-category.list'`
  - `CATALOG_TAX_CATEGORY_CREATE = 'catalog.tax-category.create'`
  - `CATALOG_VARIANT_ATTACH_TAX_CATEGORY = 'catalog.variant.attach-tax-category'`
- Wire all new providers in `PricingModule.providers` + export `SelectApplicablePriceUseCase` so task-04's `Publish Product` (in `catalog/` module) can inject it.
- Unit specs for the four behavioural use cases (Set, Schedule, Select, Attach).
- Doc deliverable `05-select-applicable-price.md`.

**Out:**

- HTTP DTOs / controllers / pipes at the gateway — task-05.
- The Kulala http file — task-06.
- The `Publish Product` hard-fail rewire — task-04.
- E2E pricing test — runs after task-05's gateway endpoints land (the e2e file is authored in task-07).
- Cache-aside on `Select Applicable Price` — explicitly out of scope this epic.

## `SetPriceUseCase` — algorithm

Input DTO (interface): `{ variantId: number, currency: string, amountMinor: number, priority?: number, validFrom?: Date, validTo?: Date | null }`.

Steps, in a single TypeORM transaction:

1. Resolve `validFromResolved = input.validFrom ?? clock.now()`.
2. If `validFromResolved > clock.now()`, throw `DomainError('Use SchedulePriceUseCase for future-dated prices')`. (The "Set" path is for now-effective prices; the "Schedule" path is for future-dated prices. Routing two near-identical paths through two named use cases makes the audit trail self-describing — `catalog.price.changed` vs. `catalog.price.scheduled`.)
3. `SELECT … FOR UPDATE` on the open row for `(variantId, currency)` via `priceRepo.findCurrentlyOpenFor(variantId, currency)` — this depends on the typeorm adapter performing the read inside the transaction with the right lock hint. Implement `findCurrentlyOpenFor` with a `setLock('pessimistic_write')` call in the QueryBuilder.
4. If a predecessor exists: `predecessor.closeAt(validFromResolved, clock)` (domain operation) → `priceRepo.closePredecessor(updatedPredecessor)`. The closed `validTo` equals the new row's `validFrom`. Two consequences: the close is exact (no gap, no overlap) and `findApplicable` continues to return the predecessor for `asOf` instants strictly before `validFromResolved`.
5. Construct the new `Price` via `Price.create(input, clock)`.
6. `priceRepo.insert(newPrice)`.
7. Commit. **After commit** (not before — events outside the DB transaction must reflect committed state), call `eventPublisher.publishPriceChanged({ variantId, currency, amountMinor, validFrom, validTo, priority, eventVersion: 'v1', correlationId })`.
8. Return the newly inserted Price.

**Error shape**: if the functional unique index from task-02 fires (concurrent insert race), the use case catches the `QueryFailedError` with the relevant SQLSTATE / `errno` code and rethrows as a `ConcurrencyError('Another open Price exists for this scope')`. The api-gateway maps `ConcurrencyError` to `409 Conflict` in task-05.

**Correlation id**: pulled from the request context (epic-02 wired `cls-hooked` / NestJS request scope for correlation; this use case calls into the same `CorrelationContext` port). If the call originates from an admin endpoint, the gateway has already set the correlation id; if from a system caller (rare in this epic), generate one.

## `SchedulePriceUseCase` — algorithm

Input DTO: same shape as `SetPriceUseCase`. Steps:

1. Reject if `input.validFrom` is missing or `<= clock.now()`. (The use case's reason for existing is that `validFrom > now`.)
2. **Do not close any predecessor.** The future Price coexists; the resolution algorithm picks the right row at `asOf`.
3. Reject if a scheduled Price already exists for `(variantId, currency)` whose `validFrom` overlaps the input's window (extra method `priceRepo.findScheduledOverlapping(variantId, currency, validFrom, validTo)` — implement as a `SELECT … WHERE valid_from >= now AND […overlap math…] LIMIT 1` query). The aim is to avoid silently shadowing a previously-scheduled future change. Document this constraint in the doc deliverable; if the team later decides overlapping schedules with different priorities should be allowed, the check moves to the use case opt-in path.
4. Construct via `Price.create({…, validFrom, validTo, priority}, clock)`. Note: `Price.create` already enforces `validFrom >= clock.now()`; this use case's pre-check is redundant but produces a friendlier error message.
5. `priceRepo.insert(newPrice)`.
6. After commit, `eventPublisher.publishPriceScheduled({ ..., effectiveAt: validFrom, eventVersion: 'v1', correlationId })`.

`PriceScheduled` is structurally a `PriceChanged` plus an `effectiveAt` field. Two separate routing keys are emitted (not one) so audit consumers can distinguish "the price has changed now" from "a price change is queued for later." Document this rationale in the doc.

## `SelectApplicablePriceUseCase` — algorithm

Input: `{ variantId: number, currency: string, asOf?: Date }`. Output: `Price | null`.

Steps:

1. `resolvedAsOf = asOf ?? clock.now()`.
2. Delegate to `priceRepo.findApplicable(variantId, currency, resolvedAsOf)`.
3. Return the result.

The repository's SQL:

```sql
SELECT *
FROM   price
WHERE  variant_id = ?
  AND  currency   = ?
  AND  valid_from <= ?
  AND  (valid_to IS NULL OR valid_to > ?)
ORDER BY priority DESC, valid_from DESC
LIMIT 1;
```

Tiebreak rules:

- **Primary**: `priority DESC` — explicit operator intent wins over implicit timing.
- **Secondary**: `valid_from DESC` — among equal priority, the newer record wins. This makes "Set Price now" durably visible even if a same-priority row coexists.
- The index `idx_price_lookup (variant_id, currency, valid_from DESC)` from task-02 supports the query; the optimizer reads the index forward / backward and applies the priority sort on a small candidate set.

**Edge cases:**

- No Price exists for the scope → return `null`. Caller decides whether that is fatal (`Publish Product` will treat null as fatal in task-04; the `GET …/price` read endpoint in task-05 returns `404 Not Found`).
- All Prices for the scope have `valid_from > asOf` (none yet effective) → return `null` (same as "no Price exists" from the caller's perspective).
- Two rows with identical `priority` AND identical `valid_from` (highly unlikely in production; possible in a seed) → the SQL's tiebreak falls to whichever row the storage engine returns first. Add a final tiebreak: `id DESC` (most-recently-inserted wins). Update the SQL: `ORDER BY priority DESC, valid_from DESC, id DESC`. Document in the doc.

## RPC controller + message patterns

`apps/catalog-microservice/src/modules/pricing/presentation/pricing.controller.ts`:

```ts
@Controller()
export class PricingController {
  constructor(
    private readonly setPrice: SetPriceUseCase,
    private readonly schedulePrice: SchedulePriceUseCase,
    private readonly selectApplicablePrice: SelectApplicablePriceUseCase,
    private readonly listPricesInEffect: ListPricesInEffectUseCase,
    private readonly listTaxCategories: ListTaxCategoriesUseCase,
    private readonly createTaxCategory: CreateTaxCategoryUseCase,
    private readonly attachTaxCategory: AttachTaxCategoryToVariantUseCase,
  ) {}

  @MessagePattern(MicroserviceMessagePatternEnum.CATALOG_PRICE_SET)
  setPriceHandler(@Payload() input: SetPriceDto) { return this.setPrice.execute(input); }

  // … one handler per pattern …
}
```

Match the existing catalog controller's import + decoration shape exactly. If the existing controllers split write and read across two controllers (e.g. `CatalogWriteController` + `CatalogReadController`), apply the same split here (`PricingWriteController` + `PricingReadController`); otherwise keep one file.

## Event publisher

`apps/catalog-microservice/src/modules/pricing/infrastructure/messaging/pricing.event-publisher.ts`:

- Injects the existing RMQ client from `MessagingModule`.
- Two methods: `publishPriceChanged(payload)` and `publishPriceScheduled(payload)`.
- Payload shape exported as a TypeScript type alias from `…/modules/pricing/application/ports/event-publisher.port.ts`; the type lives in `libs/contracts/events/` if epic-02 has already established that convention (check `libs/contracts/` first; clone its layout).

Payload contracts (frozen at v1 — task-04 + future `epic-11` audit consumer + future `epic-05` cart snapshot all key on these):

```ts
type PriceChangedEvent = {
  eventVersion: 'v1';
  variantId: number;
  currency: string;
  amountMinor: number;
  validFrom: string;             // ISO-8601 UTC
  validTo: string | null;        // ISO-8601 UTC or null
  priority: number;
  correlationId: string;
};

type PriceScheduledEvent = PriceChangedEvent & {
  effectiveAt: string;           // === validFrom for clarity at audit-read time
};
```

The use cases call the publisher **after the DB transaction commits**, not before — otherwise a failed commit + successful publish would emit a phantom event. If the existing event-publisher pattern in epic-02 already addresses this via an outbox / "post-commit hook," use it; if not, the simplest correct implementation is to publish synchronously in `try { await runInTx(); } finally { if (committed) await publish() }`. Document the call ordering in the doc deliverable and link to ADR-008.

## Cross-module: `AttachTaxCategoryToVariantUseCase`

Lives in `pricing/application/use-cases/`. Constructor injects:

- `taxCategoryRepo: TaxCategoryRepositoryPort` (from `pricing/application/ports/`).
- `productVariantRepo: ProductVariantRepositoryPort` (from `catalog/application/ports/` — already exported by epic-02's `CatalogModule`).

Algorithm:

1. Look up the `TaxCategory` by code; if not found, throw `NotFoundError`.
2. Look up the `ProductVariant` by id; if not found, throw `NotFoundError`.
3. `productVariant.attachTaxCategory(taxCategory.id)`.
4. Persist via `productVariantRepo.save(productVariant)`.
5. No event emitted (variant header changes do not flow into the audit/event-store stream in this epic — re-evaluate when `epic-11` lands; document the choice in the doc).

The cross-module discipline is the load-bearing detail here: the use case lives in the `pricing/` module and imports a port from the `catalog/` module. The port lives at the application boundary, not the domain — verify by grepping `apps/catalog-microservice/src/modules/catalog/application/ports/` for the `ProductVariantRepositoryPort` export; if it is missing, this task adds the export in the catalog module's `application/ports/index.ts` (the port itself already exists from epic-02). This is the only catalog-module touch in this task.

## `PricingModule` wiring

Add to `providers:`:

```ts
SetPriceUseCase,
SchedulePriceUseCase,
SelectApplicablePriceUseCase,
ListPricesInEffectUseCase,
ListTaxCategoriesUseCase,
CreateTaxCategoryUseCase,
AttachTaxCategoryToVariantUseCase,
{ provide: PRICING_EVENT_PUBLISHER_PORT, useClass: PricingEventPublisher },
```

Add to `controllers:`:

```ts
PricingController, // or [PricingWriteController, PricingReadController] per the chosen shape
```

Add to `exports:`:

```ts
SelectApplicablePriceUseCase,
```

The `exports:` list grows by exactly one symbol — task-04's `Publish Product` use case injects `SelectApplicablePriceUseCase` to enforce the new precondition. Other pricing symbols stay private to the module.

## Tests

Unit specs added in this task (under `…/modules/pricing/application/use-cases/spec/`):

- `set-price.use-case.spec.ts`:
  - Happy path: no predecessor → inserts; emits `catalog.price.changed`; returns the new row.
  - Predecessor exists → closes its `validTo` to the new `validFrom`; inserts the new row; both `closePredecessor` and `insert` are called within the same transaction (use the test double's transaction-scope assertion).
  - Throws when `validFrom > now`.
  - When the typeorm adapter raises a unique-constraint error, the use case translates it to `ConcurrencyError`.
  - Event is **not** emitted if the transaction throws — assertion that on a thrown `insert`, `publishPriceChanged` is never called.
- `schedule-price.use-case.spec.ts`:
  - Throws if `validFrom <= now`.
  - Happy path with no overlap: inserts; emits `catalog.price.scheduled` with `effectiveAt === validFrom`.
  - Throws on overlap with an existing scheduled row.
  - Current `Select Applicable Price` answer is unchanged after scheduling (verify by calling the select use case with a fake clock; the future row must not surface for `asOf < validFrom`).
- `select-applicable-price.use-case.spec.ts`:
  - Returns null when no Price exists.
  - Returns null when all Prices have `validFrom > asOf`.
  - With two open Prices of different priority: higher priority wins.
  - With two open Prices of equal priority and different `validFrom`: newer `validFrom` wins.
  - With two open Prices of equal `priority` and equal `validFrom`: higher `id` wins.
  - Closed Prices (with `validTo <= asOf`) are excluded.
- `attach-tax-category-to-variant.use-case.spec.ts`:
  - Happy path: variant gains `taxCategoryId`.
  - Throws `NotFoundError` when code is unknown.
  - Throws `NotFoundError` when variant id is unknown.

The fake clock is constructed locally in each spec (a tiny `{ now: () => Date }` test double). The fake event publisher records emitted payloads in-memory for assertion.

The concurrency test for the `validTo IS NULL` invariant lives in the e2e file (task-07) — it needs a real DB to exercise the unique index. The unit spec mocks the storage layer and therefore cannot exercise the race itself.

## Files to add

- `apps/catalog-microservice/src/modules/pricing/application/use-cases/set-price.use-case.ts`.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/schedule-price.use-case.ts`.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/select-applicable-price.use-case.ts`.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/list-prices-in-effect.use-case.ts`.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/list-tax-categories.use-case.ts`.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/create-tax-category.use-case.ts`.
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/attach-tax-category-to-variant.use-case.ts`.
- Spec files for all of the above except the two thin list use cases (cover via e2e in task-07).
- `apps/catalog-microservice/src/modules/pricing/application/dto/*.ts` — `SetPriceDto`, `SchedulePriceDto`, `SelectPriceDto`, `ListPricesDto`, `CreateTaxCategoryDto`, `AttachTaxCategoryDto`. These are plain TypeScript interfaces.
- `apps/catalog-microservice/src/modules/pricing/application/ports/event-publisher.port.ts` — `PricingEventPublisherPort` interface + injection token; payload types.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/messaging/pricing.event-publisher.ts`.
- `apps/catalog-microservice/src/modules/pricing/presentation/pricing.controller.ts` (or split write/read per existing convention).
- `apps/catalog-microservice/src/modules/pricing/domain/concurrency.error.ts` (or extend an existing error hierarchy under `libs/ddd/` if one exists).
- `docs/implementation/epic-03-pricing-price-and-tax-category/05-select-applicable-price.md`.

## Files to modify

- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/price.typeorm.repository.ts` — implement `findApplicable`, `findCurrentlyOpenFor` (with `setLock('pessimistic_write')`), `findScheduledOverlapping`, `findAllInEffect`, `closePredecessor`. (Skeleton present from task-02; this task fills the methods.)
- `apps/catalog-microservice/src/modules/pricing/infrastructure/pricing.module.ts` — extend `providers:`, `controllers:`, `exports:`.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` — add the seven new patterns.
- `apps/catalog-microservice/src/modules/catalog/application/ports/index.ts` — re-export `ProductVariantRepositoryPort` if not already exported (needed by `AttachTaxCategoryToVariantUseCase`).
- `libs/messaging/microservice-client-catalog.module.ts` — if epic-02 task-01 stubbed the client module without the new RPC bindings, extend the `ClientsModule` registration. Concretely, the api-gateway already speaks to `catalog_queue`; the new patterns ride that same queue, so the client wiring should not need to change. **Verify** by reading the existing client module after task-01 of epic-02 landed; modify only if a new binding is required.

## Files to delete

None.

## Doc deliverable

Write `docs/implementation/epic-03-pricing-price-and-tax-category/05-select-applicable-price.md`. Target ~180 lines. Sections:

1. **What "applicable" means.** The closed/open interval rule. The two ordering axes — `priority` (explicit operator intent), then `valid_from` (newer wins). The final tiebreak on `id`. Why the resolution is monotonic — a later `Set Price` cannot make an earlier `asOf` answer change (the closed predecessor row is still there in the table). Property: historic `asOf` queries are stable across future writes.
2. **The SQL, with the index.** The exact query, the matching index, why the optimizer picks it. Why the priority sort is acceptable on a small candidate set (per `(variantId, currency)` scope, the number of rows whose `valid_from <= asOf < valid_to` is bounded by the lifetime of the variant; for the walking-skeleton seed it is exactly one).
3. **What happens when no Price applies.** Three flavors of null: (a) no row exists for the scope, (b) every row has `valid_from > asOf` (only future-scheduled), (c) every row has `valid_to <= asOf` (only historic; an unusual but legal state if the operator has not set a new Price after closing the last open one). All three return `null` from the use case. Each caller decides what to do: `Publish Product` rejects, the gateway read returns 404, a future cart snapshot is responsible for refusing to write the line.
4. **The Set vs. Schedule path split.** Why two named use cases, two routing keys, two specs. The signal-to-noise argument: audit consumers can filter `catalog.price.scheduled` to project "what changes are queued for the next hour."
5. **Predecessor close semantics.** The "exact-match close" — `predecessor.validTo = newPrice.validFrom`. No gap, no overlap. The transaction shape. The pessimistic lock. The functional unique index as the second line of defense.
6. **The cross-module RPC surface.** The seven new `catalog.*` patterns. Why pricing reuses `catalog_queue` rather than introducing `pricing_queue` — the message bus colocation mirrors the module colocation. Forward-link: if pricing later splits into its own microservice (Day-2), the patterns rename to `pricing.*` and the routing keys move with them.
7. **Event payload v1 contract.** Why `v1` is encoded in the payload, not the routing key. The two payloads side-by-side. The `effectiveAt` distinction. Forward-link to `epic-11`'s audit-store consumer + `epic-05`'s cart snapshot — both bind to v1 explicitly.
8. **What this task did NOT touch.** Forward-links to task-04 (publish hard-fail), task-05 (gateway endpoints), task-07 (e2e, seed, currency-immutability doc).

## Carryover produced (consumed by task-04 onward)

- `SelectApplicablePriceUseCase` is exported from `PricingModule`. Task-04's `Publish Product` injects it.
- The seven new RPC patterns are registered in the contracts enum; task-05 (gateway) wires HTTP routes to them.
- The two event payloads (`v1`) are frozen contracts; downstream consumers (audit store in `epic-11`, cart snapshot in `epic-05`) can bind to them.
- Concurrency tests run in unit form here; the live concurrency test against MySQL lives in task-07's e2e suite.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); no cross-module-import-ban violations in `pricing/`.
- [ ] `yarn test:unit` passes; all four new behavioural specs are green; the `Price` and `TaxCategory` model specs from task-02 still pass.
- [ ] `yarn build:catalog-microservice` succeeds.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev:catalog-microservice` boots the microservice with the seven new `@MessagePattern` handlers registered (the startup logs show them, mirroring how epic-02's `catalog.product.*` patterns appear at boot).
- [ ] Calling the RPC patterns over RabbitMQ (manually via a small `nest microservice` test or via the api-gateway in task-05) returns Price / TaxCategory data shapes — exercise once after task-05 lands; not gateable here on its own.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `05-select-applicable-price.md` exists and is filled per the section list.
