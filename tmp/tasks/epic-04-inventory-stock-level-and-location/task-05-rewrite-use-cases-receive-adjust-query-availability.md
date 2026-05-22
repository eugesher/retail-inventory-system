---
epic: epic-04
task_number: 5
title: Rewrite the use case layer — Receive Stock, Adjust Stock, Query Availability
depends_on: [01, 02, 03, 04]
doc_deliverable: docs/implementation/epic-04-inventory-stock-level-and-location/06-receive-and-adjust-use-cases.md and 07-availability-read-path.md
---

# Task 05 — Rewrite the use case layer

## Goal

Replace the three legacy use cases (`AddStockUseCase`, `GetStockUseCase`, `ReserveStockForOrderUseCase`) with the three new use cases the epic charters (`ReceiveStockUseCase`, `AdjustStockUseCase`, `QueryAvailabilityUseCase`). The `Reserve Stock` flow goes away entirely from this epic — it is owned by `epic-07`. The legacy `@MessagePattern` handlers in `stock.controller.ts` go away too (their RMQ routing keys remain registered through this task; task-08 retires `inventory.product-stock.get` and reshapes `inventory.order.confirm` into a deprecation handler). The three new use cases are not wired to RMQ at all in this epic — they are called directly from the api-gateway side (task-09) via a port that ultimately resolves to either an in-process direct call (if the api-gateway and inventory-microservice are colocated for dev/test) or an RMQ adapter (currently the production wiring). Task-09 owns that adapter rewrite; this task focuses on the use case layer inside the inventory microservice.

The cache-aside contract from ADR-002 / ADR-006 / ADR-016 / ADR-021 is preserved on the read path: `QueryAvailabilityUseCase` calls `IStockCachePort.getOrLoad(...)` with the new payload shape. The cached value is now a `StockLevel` projection (or list of projections — one per location) rather than the legacy SUM aggregate. The cache write path on the two mutator use cases routes through `IStockCachePort.withInvalidation(work, resolveItems, opts)` per ADR-023 — `resolveItems` returns `[{ variantId, stockLocationId }]` (was `[{ productId, storageId }]`, hence the DTO-shape break that drives the cache key v1 → v2 bump in task-06).

## Entry state assumed

Task-04 carryover present:

- `StockLevel` full aggregate on disk with `receive` / `applySignedDelta` / `pullDomainEvents` / `setLowStockThreshold` mutators and getters.
- `StockLocation` domain class on disk.
- `IStockRepositoryPort` (new five-method shape) implemented by `StockTypeormRepository`.
- `IStockLocationRepositoryPort` implemented by the same repository.
- Three legacy use case files temporarily stubbed; their specs `describe.skip(...)`'d.
- `stock.controller.ts` `@MessagePattern` handler bodies throw the temporary stub error.
- `StockCache` is still the **old** implementation (productId-keyed, returns SUM aggregate). Task-06 rewrites it; this task wires the new use cases against the **interface contract** (`IStockCachePort.getOrLoad` / `.withInvalidation`), so the interface change has to be coordinated. Concretely: this task **first reshapes the port interface** (`IStockCachePort` + payload types) to be `variantId` + `stockLocationId` keyed, then rewrites the use cases against the new interface, then ships a transitional `StockCache` adapter that no-ops the new methods (the cache is effectively disabled between this task and task-06). Task-06 lands the v2 implementation.

## Scope

**In:**

- Reshape `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts`:
  - `IStockCacheGetPayload` → `{ variantId: number; stockLocationIds?: string[]; tenantId?: string; correlationId?: string }`.
  - `IStockCacheSetPayload` → same plus `data: StockAvailabilityProjection`.
  - `IStockCacheInvalidateItem` → `{ variantId: number; stockLocationId: string }`.
  - `IStockCacheGetResult` and `IStockWithInvalidationOptions` keep the same shape (`tenantId?` / `correlationId?` + `value` / `available`).
  - The cached value type changes from `ProductStockGetResponseDto` to a new `IStockAvailabilityProjection` (defined under `libs/contracts/inventory/`). Task-09 surfaces this same projection at the api-gateway response boundary.
- Define `IStockAvailabilityProjection` in `libs/contracts/inventory/stock-availability/`. Shape:
  ```ts
  export interface IStockLevelProjection {
    variantId: number;
    stockLocationId: string;
    quantityOnHand: number;
    quantityAllocated: number;
    quantityReserved: number;
    available: number; // derived; server-side computed
    version: number;
    updatedAt: string; // ISO 8601
  }
  export interface IStockAvailabilityProjection {
    variantId: number;
    totalAvailable: number;
    levels: IStockLevelProjection[];
  }
  ```
- Delete `libs/contracts/inventory/product-stock/` entirely (the legacy `ProductStockGetResponseDto`, the request payload types). All its consumers go away in this epic.
- New use case `apps/inventory-microservice/src/modules/stock/application/use-cases/receive-stock.use-case.ts` + spec.
- New use case `apps/inventory-microservice/src/modules/stock/application/use-cases/adjust-stock.use-case.ts` + spec.
- New use case `apps/inventory-microservice/src/modules/stock/application/use-cases/query-availability.use-case.ts` + spec.
- New presentation handler in `stock.controller.ts`: three `@MessagePattern` handlers for `inventory.stock.receive`, `inventory.stock.adjust`, `inventory.stock.query-availability` (routing keys added in task-08; this task uses string literals temporarily and the comment marks them for the task-08 rewrite).
- Delete the three legacy use case files (`add-stock.use-case.ts`, `get-stock.use-case.ts`, `reserve-stock-for-order.use-case.ts`) and their `.spec.ts` files. Update `application/use-cases/index.ts` to drop the stale exports and add the new ones.
- Update `stock.module.ts` provider list: drop the three legacy use cases; add the three new ones.
- Transitional `StockCache` adapter: rewrite the file to satisfy the new `IStockCachePort` interface; for now, every method is a no-op (`get` returns `{ value: undefined, available: true }`; `set` does nothing; `getOrLoad` calls the loader unconditionally; `withInvalidation` runs `work` and skips the prefix-delete). Task-06 ships the real v2 implementation. The transitional state means the cache is disabled between this task and task-06 — acceptable since no production data exists.
- Update `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts`: rewrite against the new no-op shape **or** mark `describe.skip(...)` (the spec will be fully rewritten by task-06 against the real v2 implementation; skipping it for this task is cleaner).
- Two doc deliverables: `06-receive-and-adjust-use-cases.md` (use-case half — event emission half lands in task-08) and `07-availability-read-path.md`.

**Out:**

- The cache-key version bump and the full v2 `StockCache` implementation — task-06.
- The variant-created consumer — task-07.
- The RMQ publisher wiring — task-08.
- The api-gateway HTTP endpoints — task-09.
- New RMQ routing keys (`inventory.stock.receive`, etc.) registered in `libs/messaging/routing-keys.constants.ts` — task-08 registers them; this task uses inline string literals with a TODO marker.

## `ReceiveStockUseCase` shape

```ts
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IStockAvailabilityProjection,
  IStockLevelProjection,
} from '@retail-inventory-system/contracts';

import { StockLevel } from '../../domain';
import {
  IStockCachePort,
  IStockRepositoryPort,
  IStockLocationRepositoryPort,
  STOCK_CACHE,
  STOCK_LOCATION_REPOSITORY,
  STOCK_REPOSITORY,
} from '../ports';

export interface IReceiveStockPayload {
  variantId: number;
  stockLocationId?: string; // defaults to 'default-warehouse' if omitted
  quantity: number;
  actorId?: string;
  correlationId?: string;
}

@Injectable()
export class ReceiveStockUseCase {
  private static readonly DEFAULT_STOCK_LOCATION_ID = 'default-warehouse';

  constructor(
    @Inject(STOCK_REPOSITORY) private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_LOCATION_REPOSITORY)
    private readonly locations: IStockLocationRepositoryPort,
    @Inject(STOCK_CACHE) private readonly cache: IStockCachePort,
    @InjectPinoLogger(ReceiveStockUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IReceiveStockPayload): Promise<IStockLevelProjection> {
    const { variantId, quantity, actorId, correlationId } = payload;
    const stockLocationId =
      payload.stockLocationId ?? ReceiveStockUseCase.DEFAULT_STOCK_LOCATION_ID;

    // Preconditions checked before the cache-invalidation wrapper because
    // a failed precondition does not invalidate the cache.
    const location = await this.locations.findById(stockLocationId);
    if (!location || !location.active) {
      throw new InvalidStockLocationError(stockLocationId, location?.active);
    }

    return this.cache.withInvalidation(
      async () => {
        // The repository's `incrementOnHand` is an atomic SQL UPDATE that
        // returns the post-update row constructed through the aggregate's
        // load-time invariants. The aggregate's `receive(amount)` mutator
        // is not called here — the UPDATE bypasses read-modify-write by
        // construction, and the returned aggregate already carries the
        // bumped `version`. (The event emission for `StockReceivedEvent`
        // is wired in task-08 via a hand-crafted construction inside the
        // repository — the aggregate-based path is the test double's
        // behavior in `*.use-case.spec.ts`; the live path emits via the
        // publisher port directly.)
        const level = await this.repository.incrementOnHand({
          variantId,
          stockLocationId,
          amount: quantity,
          correlationId,
        });
        this.logger.info(
          { correlationId, variantId, stockLocationId, quantity, actorId, newOnHand: level.quantityOnHand },
          'Stock received',
        );
        // The publisher emission happens here (task-08 fills it in). For
        // this task the line is a TODO — the projection is returned
        // immediately.
        return this.toProjection(level);
      },
      (projection) => [{ variantId: projection.variantId, stockLocationId: projection.stockLocationId }],
      { correlationId },
    );
  }

  private toProjection(level: StockLevel): IStockLevelProjection {
    return {
      variantId: level.variantId,
      stockLocationId: level.stockLocationId,
      quantityOnHand: level.quantityOnHand,
      quantityAllocated: level.quantityAllocated,
      quantityReserved: level.quantityReserved,
      available: level.available,
      version: level.version,
      updatedAt: (level as any).updatedAt?.toISOString() ?? new Date().toISOString(),
    };
  }
}
```

Two subtleties to call out for the implementer:

- The atomic UPDATE path (`incrementOnHand`) bypasses the aggregate's `receive(amount)` method. The use case **does not** load → mutate → save; it issues one SQL UPDATE and reads the post-update row through the mapper. This is OK because the no-oversell + version-bump invariants live in the SQL `WHERE` clause + TypeORM's `@VersionColumn()` mechanics, not in the aggregate's method body. The aggregate's `receive(amount)` is exercised by the **test double** in `*.use-case.spec.ts` (an in-memory `IStockRepositoryPort` implementation that does load-mutate-save), so the invariant coverage is preserved at the unit-test level.
- The `IStockCacheInvalidateItem` shape from `resolveItems` is `{ variantId, stockLocationId }`. Task-06's v2 `StockCache.invalidatePrefixes` uses this to build the prefix-delete pattern.

`InvalidStockLocationError` is a custom error class added under `apps/inventory-microservice/src/modules/stock/domain/errors/` (new subfolder) — typed so the controller layer can translate it to `409 Conflict` (or `422 Unprocessable Entity` — task-09 picks the status code).

## `AdjustStockUseCase` shape

Same structure as `ReceiveStockUseCase`, but uses `repository.applySignedDelta(...)`. Payload type:

```ts
export interface IAdjustStockPayload {
  variantId: number;
  stockLocationId?: string;
  quantityDelta: number; // signed
  reasonCode: string;
  actorId?: string;
  correlationId?: string;
}
```

Preconditions:

- `reasonCode` non-empty (the use case asserts this even though the aggregate does too; the use case error is a typed `MissingReasonCodeError` so the controller maps it to `400 Bad Request` rather than `409 Conflict`).
- Location active (same check as Receive).
- Signed delta non-zero (handled by the aggregate / atomic UPDATE).

The atomic UPDATE returns the post-update row. If zero rows were affected (because the delta would have driven `quantityOnHand` below zero, or below `allocated + reserved`), the repository surfaces a typed `StockInvariantViolationError`; the use case rethrows; the controller translates to `409 Conflict`.

`reasonCode` is carried in the request body and logged, but **not persisted in a table** in this epic — the StockMovement table is owned by epic-07. The doc deliverable forward-links to epic-07 and explicitly says the reasonCode goes into the Pino log + the eventual future-StockMovement payload + the emitted `inventory.stock.adjusted` event (task-08); a database column for it does not exist yet.

## `QueryAvailabilityUseCase` shape

```ts
export interface IQueryAvailabilityPayload {
  variantId: number;
  stockLocationIds?: string[]; // omit ⇒ all active locations
  tenantId?: string;
  correlationId?: string;
}

@Injectable()
export class QueryAvailabilityUseCase {
  constructor(
    @Inject(STOCK_REPOSITORY) private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_CACHE) private readonly cache: IStockCachePort,
    @InjectPinoLogger(QueryAvailabilityUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IQueryAvailabilityPayload): Promise<IStockAvailabilityProjection> {
    return this.cache.getOrLoad(payload, () => this.loadFromDb(payload));
  }

  private async loadFromDb(
    payload: IQueryAvailabilityPayload,
  ): Promise<IStockAvailabilityProjection> {
    const { variantId } = payload;
    const levels = await this.repository.findByVariant({ variantId, correlationId: payload.correlationId });
    // Filter by stockLocationIds if provided.
    const filtered = payload.stockLocationIds
      ? levels.filter((l) => payload.stockLocationIds!.includes(l.stockLocationId))
      : levels;
    const projections = filtered.map((l) => this.toProjection(l));
    const totalAvailable = projections.reduce((sum, p) => sum + p.available, 0);
    return { variantId, totalAvailable, levels: projections };
  }

  // toProjection — same shape as ReceiveStock's
}
```

Cache-skip rules:

- The `tenantId` and `correlationId` are carried through to the cache key (per ADR-022's opt-in tenant segment).
- The cache is skipped if no projection rows are returned from the DB (a `findByVariant` miss returns an empty `levels` array — caching emptiness would mask a freshly-auto-init'd row that hasn't been picked up yet). The skip-on-empty rule is documented in `07-availability-read-path.md`.

## `stock.controller.ts` rewrite

The three legacy handlers are deleted. Three new handlers added, against placeholder routing-key strings (task-08 registers the actual constants and this task's controller will get a one-line fix). For this task:

```ts
@MessagePattern('inventory.stock.receive') // TODO(epic-04 task-08): ROUTING_KEYS.INVENTORY_STOCK_RECEIVE
public async handleReceive(@Payload() payload: IReceiveStockPayload): Promise<IStockLevelProjection> {
  return this.receiveStockUseCase.execute(payload);
}

@MessagePattern('inventory.stock.adjust') // TODO(epic-04 task-08): ROUTING_KEYS.INVENTORY_STOCK_ADJUST
public async handleAdjust(@Payload() payload: IAdjustStockPayload): Promise<IStockLevelProjection> {
  return this.adjustStockUseCase.execute(payload);
}

@MessagePattern('inventory.stock.query-availability') // TODO(epic-04 task-08): ROUTING_KEYS.INVENTORY_STOCK_QUERY_AVAILABILITY
public async handleQuery(@Payload() payload: IQueryAvailabilityPayload): Promise<IStockAvailabilityProjection> {
  return this.queryAvailabilityUseCase.execute(payload);
}
```

The constructor injects the three new use cases. The old `getStockUseCase` / `reserveStockForOrderUseCase` fields are gone.

## Files to add

- `apps/inventory-microservice/src/modules/stock/application/use-cases/receive-stock.use-case.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/adjust-stock.use-case.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/query-availability.use-case.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/receive-stock.use-case.spec.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/adjust-stock.use-case.spec.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/query-availability.use-case.spec.ts`
- `apps/inventory-microservice/src/modules/stock/domain/errors/invalid-stock-location.error.ts`
- `apps/inventory-microservice/src/modules/stock/domain/errors/missing-reason-code.error.ts`
- `apps/inventory-microservice/src/modules/stock/domain/errors/stock-invariant-violation.error.ts`
- `apps/inventory-microservice/src/modules/stock/domain/errors/index.ts`
- `libs/contracts/inventory/stock-availability/stock-availability.projection.ts` (+ `index.ts`)
- `docs/implementation/epic-04-inventory-stock-level-and-location/06-receive-and-adjust-use-cases.md`
- `docs/implementation/epic-04-inventory-stock-level-and-location/07-availability-read-path.md`

## Files to modify

- `apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts` — new payload + invalidate shapes; `IStockAvailabilityProjection` as the cached value type.
- `apps/inventory-microservice/src/modules/stock/application/ports/index.ts` — re-export the new shapes.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/test-doubles.ts` — add an in-memory `IStockCachePort` double + the new repository double.
- `apps/inventory-microservice/src/modules/stock/application/use-cases/index.ts` — drop the three legacy exports, add the three new ones.
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/stock.cache.ts` — transitional no-op rewrite (task-06 lands the v2 implementation).
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts` — `describe.skip(...)` until task-06 owns it.
- `apps/inventory-microservice/src/modules/stock/presentation/stock.controller.ts` — three new `@MessagePattern` handlers; the three legacy ones gone.
- `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts` — provider list: drop legacy use cases; add the three new ones.
- `apps/inventory-microservice/src/modules/stock/domain/index.ts` — re-export the new errors.
- `libs/contracts/inventory/index.ts` — re-export from `stock-availability/`; drop the `product-stock/` re-exports.

## Files to delete

- `apps/inventory-microservice/src/modules/stock/application/use-cases/add-stock.use-case.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/get-stock.use-case.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/add-stock.use-case.spec.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/get-stock.use-case.spec.ts`
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/reserve-stock-for-order.use-case.spec.ts`
- `libs/contracts/inventory/product-stock/` (entire subtree — `product-stock-get/`, `product-stock-order-confirm/`, `product-stock.types.ts`)

## Tests

- `receive-stock.use-case.spec.ts` — ≥6 cases: happy path; non-positive quantity rejected; location-not-found rejected; location-inactive rejected; cache invalidate called with `{ variantId, stockLocationId }`; emitted event count = 1 (`StockReceivedEvent` from the test-double aggregate path).
- `adjust-stock.use-case.spec.ts` — ≥7 cases: positive delta happy path; negative delta happy path; zero delta rejected; missing reasonCode rejected; delta that drives onHand below zero rejected; cache invalidate called; emitted event carries the reasonCode.
- `query-availability.use-case.spec.ts` — ≥5 cases: cache hit returns cached value (no repository call); cache miss falls through to repository; multi-location aggregation produces the correct `totalAvailable`; empty `levels` array skips the cache write (or — depending on the chosen rule — caches the empty); `stockLocationIds` filter restricts the projection.
- The transitional `stock.cache.spec.ts` is `describe.skip(...)`'d.
- `yarn test:unit` passes; the test count delta is ≥+18 specs, −9 (the three deleted spec files each had ~3 cases).
- `yarn build:inventory-microservice` succeeds.

## Doc deliverables

### `06-receive-and-adjust-use-cases.md` — written entirely by this task

Target ~140 lines. Sections:

1. **The Stage-1 inventory operations.** Restate the epic's scope: Receive Stock + Adjust Stock (write) + Query Availability (read). The deferred operations (Allocate, Commit Sale, Cancel Allocation, Restock from Return, Transfer Stock) get a forward link to `epic-07` / `epic-08` / `epic-09`.
2. **Receive Stock — preconditions + flow.** The location-active check, the positive-quantity check, the atomic UPDATE path. Why the aggregate's `receive(amount)` mutator is bypassed by the live path (the SQL UPDATE is the source of truth for the column mutation; the aggregate covers the same ground in test doubles).
3. **Adjust Stock — preconditions + flow.** `reasonCode` mandatory; signed delta; the no-negative + no-invariant-violation guards. Mention the future StockMovement table from `epic-07`; explicitly say the `reasonCode` lives in the request log and the emitted RMQ event from task-08 but **not** in a persistent table this epic.
4. **Cache invalidation routing.** Both use cases route through `IStockCachePort.withInvalidation(work, resolveItems, opts)` per ADR-023. The `resolveItems` callback returns one `{ variantId, stockLocationId }` per mutated row. Why the post-commit ordering is type-enforced (the cache port has no public `invalidate`).
5. **Error model.** `InvalidStockLocationError` → `409`; `MissingReasonCodeError` → `400`; `StockInvariantViolationError` → `409`. The api-gateway controller (task-09) does the HTTP translation.
6. **The deferred StockMovement audit row.** A forward-looking paragraph: every Receive/Adjust today produces only a Pino log entry + the emitted RMQ event (task-08). `epic-07` will add a `stock_movement` ledger row that captures the same information durably; the audit-log consumer in `epic-11` will subscribe to the same events for compliance retention. This epic does not write to `stock_movement`.
7. **Forward links.** Task-06 (cache v2), task-07 (auto-init consumer), task-08 (event publisher).

Task-08 appends a section to this same doc documenting the **emitted event shapes** for `inventory.stock.received` and `inventory.stock.adjusted` (the routing keys and payload schemas registered in `libs/messaging/routing-keys.constants.ts`).

### `07-availability-read-path.md` — written entirely by this task

Target ~120 lines. Sections:

1. **Cache-aside contract preserved.** ADR-002 (TTL-as-safety-net), ADR-006 (read-aside semantics), ADR-016 (no string literals), ADR-021 (single-flight + jitter). All four contracts inherit through `IStockCachePort.getOrLoad(...)`. The use case has zero direct cache calls; the indirection through `getOrLoad` is what gives single-flight + TTL jitter for free.
2. **New payload shape.** The cached value is `IStockAvailabilityProjection` (one variant, multiple locations). Forward link to doc `04-cache-key-bump-v1-to-v2.md` (written by task-06) for the cache-key version bump rationale.
3. **Per-location vs aggregated read.** The use case's `stockLocationIds` filter. Omit ⇒ all locations. With one location seeded today, the difference is academic; doc explicitly notes the multi-location case is ready for `epic-15`'s "first natural extension".
4. **The skip-on-empty rule.** Why an empty `levels` array is not cached: a missing `StockLevel` row means the auto-init consumer (task-07) hasn't run yet for a freshly-created variant; caching the empty would mask that for the duration of the TTL.
5. **Public access.** The customer-facing `GET /api/inventory/variants/:variantId/stock` is `@Public()` (no auth). The admin-facing `GET /api/inventory/locations` is `inventory:read`-gated. Task-09 implements both — this doc names the contract.
6. **Cache failure modes.** Inherited from `StockCache`: Redis-down ⇒ one warn log, fall through to the DB; CACHE-005 prevents duplicate warn frames; single-flight prevents thundering-herd. Forward link to doc 04 for the v1 → v2 cache-key shape that survives a Redis-down period (no v1 entries get written by the new code path; the legacy prefix stays in the invalidate path for one transition window).
7. **Forward links.** Task-06 (the v2 `StockCache` implementation), task-09 (the api-gateway HTTP endpoint that consumes the projection).

## Carryover produced (consumed by task-06 onward)

- Three new use cases on disk: `receive-stock`, `adjust-stock`, `query-availability`.
- The three legacy use cases + their specs deleted.
- `IStockCachePort` reshaped to `variantId` + `stockLocationId` payload shape; `IStockAvailabilityProjection` defined in `libs/contracts/`.
- `StockCache` is in a transitional no-op state; the corresponding spec is `describe.skip(...)`'d.
- The controller's three new `@MessagePattern` handlers point at inline routing-key strings (task-08 swaps to constants).
- Two doc files: `06-…` (use-case half written; task-08 appends event shapes) and `07-…` (complete).
- The legacy `libs/contracts/inventory/product-stock/` subtree gone; the new `stock-availability/` projection lives at `libs/contracts/inventory/stock-availability/`.

## Exit criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; ≥18 new specs green (≥6 for receive, ≥7 for adjust, ≥5 for query); the deleted specs gone from disk.
- [ ] `yarn build:inventory-microservice` succeeds.
- [ ] `yarn start:dev:inventory-microservice` boots; an `inventory.stock.receive` RMQ call (from a manual `rabbitmqadmin publish` against the seeded `default-warehouse` + a seeded variant from epic-02) returns a valid `IStockLevelProjection`. Verified manually.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Docs `06-receive-and-adjust-use-cases.md` and `07-availability-read-path.md` exist with the sections above filled.
