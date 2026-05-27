---
epic: epic-04
task_number: 4
title: Rewrite the StockItem domain aggregate as the StockLevel aggregate
depends_on: [01, 02, 03]
doc_deliverable: docs/implementation/epic-04-inventory-stock-level-and-location/03-stocklevel-aggregate-and-version-column.md
---

# Task 04 — Rewrite the `StockItem` aggregate as `StockLevel`

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Replace the `StockItem` aggregate with the full `StockLevel` aggregate. The placeholder model put in place in task-03 grows two mutator methods (`receive(amount)`, `applySignedDelta(delta, reasonCode)`), one event-emission contract per mutator (`StockReceivedEvent` and `StockAdjustedEvent` plus the existing `StockLowEvent`), the **per-mutation `version` bump** that gives the `@VersionColumn()` column truthful contents from this commit onward, and the invariant enforcement that prevents `quantityOnHand` from going negative via the aggregate path. The deferred Reservation methods (`reserve(amount)` / `release(amount)`) are **not** added — they land in `epic-07`. The `StockReservedEvent` and `StockReleasedEvent` files in `domain/events/` are kept as files (already on disk from the pre-epic-04 era), but their payloads are restructured to be `variantId`-keyed instead of `productId`-keyed; they remain unused in this epic's emit-side wiring.

The `StockItem` domain class and its spec are **deleted** in this task. The rename is not a TypeORM column rename (the column was already taken care of in tasks 01 + 03); it is a domain-layer file removal + a fresh aggregate.

## Entry state assumed

Task-03 carryover present:

- `stock_level` table exists with `version` column.
- `StockLevel` placeholder domain class on disk; only the constructor + getters are filled. No mutator methods exposed.
- `IStockRepositoryPort` has its new five-method shape; `StockTypeormRepository` implements it.
- The three legacy use case files are stubbed; their specs are `describe.skip(...)`'d.
- `StockItem` domain class + spec still on disk (task-01 left them).
- `stock-item.mapper.ts` is gone (deleted by task-01).
- Event files `stock-reserved.event.ts`, `stock-released.event.ts`, `stock-low.event.ts` still on disk under `domain/events/`. They carry `productId` fields — those rename to `variantId` in this task.

## Scope

**In:**

- Replace the body of `apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts` with the full aggregate (constructor invariants, `receive(amount)`, `applySignedDelta(delta, reasonCode)`, the per-mutation `version` bump, the `pullDomainEvents()` event-collection method that the use cases read after a successful mutation).
- New domain event files under `apps/inventory-microservice/src/modules/stock/domain/events/`:
  - `stock-received.event.ts` — `{ variantId, stockLocationId, quantityDelta, newOnHand, actorId? }`.
  - `stock-adjusted.event.ts` — `{ variantId, stockLocationId, quantityDelta, reasonCode, newOnHand, actorId? }`.
  - `stock-level-initialized.event.ts` — `{ variantId, stockLocationId }`.
- Restructure the three existing event files (`stock-low.event.ts`, `stock-reserved.event.ts`, `stock-released.event.ts`) to be `variantId`-keyed. `StockLowEvent` is the only one with an active emit-side wire-up (the publisher in task-08 emits `inventory.stock.low` against the existing notification consumer); the other two are kept as future-use files for `epic-07`.
- Update `domain/events/index.ts` to re-export the new event classes alongside the restructured existing ones.
- New domain spec file `apps/inventory-microservice/src/modules/stock/domain/spec/stock-level.model.spec.ts` with ≥15 distinct test cases.
- Delete `apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts`.
- Delete `apps/inventory-microservice/src/modules/stock/domain/spec/stock-item.model.spec.ts`.
- Update `domain/index.ts` to drop the `StockItem` export and add the new events.
- Append the **Domain Aggregate** half to `docs/implementation/epic-04-inventory-stock-level-and-location/03-stocklevel-aggregate-and-version-column.md`.

**Out:**

- Wiring the event publisher to the three new events — task-08.
- Deleting `add-stock.use-case.ts` / `get-stock.use-case.ts` / `reserve-stock-for-order.use-case.ts` — task-05.
- New use cases that call `receive(amount)` / `applySignedDelta(...)` — task-05.

## Full `StockLevel` aggregate

```ts
import {
  StockAdjustedEvent,
  StockReceivedEvent,
  StockLowEvent,
} from './events';

export interface IStockLevelProps {
  id?: number | null;
  variantId: number;
  stockLocationId: string;
  quantityOnHand?: number;
  quantityAllocated?: number;
  quantityReserved?: number;
  version?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
  // Constructor-only — the threshold below which receive/adjust emits a
  // StockLowEvent. Default lives in the use case, not the aggregate; this
  // field is filled by the use case via `setLowStockThreshold(value)`
  // before the mutator is called. The aggregate is *threshold-agnostic*
  // unless told otherwise.
}

export interface IReceivePayload {
  amount: number;
  actorId?: string;
}

export interface IApplySignedDeltaPayload {
  delta: number;
  reasonCode: string;
  actorId?: string;
}

export class StockLevel {
  public readonly id: number | null;
  public readonly variantId: number;
  public readonly stockLocationId: string;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;
  private _quantityOnHand: number;
  private _quantityAllocated: number;
  private _quantityReserved: number;
  private _version: number;
  private _lowStockThreshold: number | null = null;
  private _events: Array<StockReceivedEvent | StockAdjustedEvent | StockLowEvent> = [];

  constructor(props: IStockLevelProps) {
    if (!Number.isInteger(props.variantId) || props.variantId <= 0) {
      throw new Error(`StockLevel: variantId must be a positive integer, got ${props.variantId}`);
    }
    if (!props.stockLocationId || props.stockLocationId.length > 64) {
      throw new Error(
        `StockLevel: stockLocationId must be a non-empty string ≤ 64 chars, got ${props.stockLocationId}`,
      );
    }

    const onHand = props.quantityOnHand ?? 0;
    const allocated = props.quantityAllocated ?? 0;
    const reserved = props.quantityReserved ?? 0;
    StockLevel.assertNonNegative('quantityOnHand', onHand);
    StockLevel.assertNonNegative('quantityAllocated', allocated);
    StockLevel.assertNonNegative('quantityReserved', reserved);
    // The aggregate's reservation+allocation invariant — even though no
    // method mutates the right-hand sides in this epic, the constructor
    // still asserts the load-time invariant so a bad row coming from the DB
    // fails fast instead of corrupting downstream callers.
    if (allocated + reserved > onHand) {
      throw new Error(
        `StockLevel: allocated (${allocated}) + reserved (${reserved}) exceeds quantityOnHand (${onHand})`,
      );
    }

    this.id = props.id ?? null;
    this.variantId = props.variantId;
    this.stockLocationId = props.stockLocationId;
    this._quantityOnHand = onHand;
    this._quantityAllocated = allocated;
    this._quantityReserved = reserved;
    this._version = props.version ?? 0;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public get quantityOnHand(): number { return this._quantityOnHand; }
  public get quantityAllocated(): number { return this._quantityAllocated; }
  public get quantityReserved(): number { return this._quantityReserved; }
  public get version(): number { return this._version; }
  public get available(): number {
    // Derived. With the constructor invariant above, this is always ≥ 0.
    return this._quantityOnHand - this._quantityAllocated - this._quantityReserved;
  }

  public setLowStockThreshold(threshold: number | null): void {
    if (threshold !== null) StockLevel.assertNonNegative('lowStockThreshold', threshold);
    this._lowStockThreshold = threshold;
  }

  public receive(payload: IReceivePayload): void {
    const { amount, actorId } = payload;
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error(`StockLevel.receive: amount must be a positive integer, got ${amount}`);
    }
    this._quantityOnHand += amount;
    this._version += 1;
    this._events.push(
      new StockReceivedEvent({
        variantId: this.variantId,
        stockLocationId: this.stockLocationId,
        quantityDelta: amount,
        newOnHand: this._quantityOnHand,
        actorId,
      }),
    );
    this.emitStockLowIfBelowThreshold();
  }

  public applySignedDelta(payload: IApplySignedDeltaPayload): void {
    const { delta, reasonCode, actorId } = payload;
    if (!Number.isInteger(delta) || delta === 0) {
      throw new Error(
        `StockLevel.applySignedDelta: delta must be a non-zero integer, got ${delta}`,
      );
    }
    if (!reasonCode || reasonCode.trim().length === 0) {
      throw new Error('StockLevel.applySignedDelta: reasonCode is required');
    }
    const next = this._quantityOnHand + delta;
    if (next < 0) {
      throw new Error(
        `StockLevel.applySignedDelta: delta ${delta} would drive quantityOnHand below zero (current ${this._quantityOnHand})`,
      );
    }
    if (next < this._quantityAllocated + this._quantityReserved) {
      throw new Error(
        `StockLevel.applySignedDelta: delta ${delta} would invalidate the allocated+reserved invariant ` +
          `(allocated ${this._quantityAllocated} + reserved ${this._quantityReserved} > new onHand ${next})`,
      );
    }
    this._quantityOnHand = next;
    this._version += 1;
    this._events.push(
      new StockAdjustedEvent({
        variantId: this.variantId,
        stockLocationId: this.stockLocationId,
        quantityDelta: delta,
        reasonCode,
        newOnHand: this._quantityOnHand,
        actorId,
      }),
    );
    this.emitStockLowIfBelowThreshold();
  }

  public pullDomainEvents(): ReadonlyArray<StockReceivedEvent | StockAdjustedEvent | StockLowEvent> {
    const events = this._events;
    this._events = [];
    return events;
  }

  private emitStockLowIfBelowThreshold(): void {
    if (this._lowStockThreshold === null) return;
    if (this.available <= this._lowStockThreshold) {
      this._events.push(
        new StockLowEvent({
          variantId: this.variantId,
          stockLocationId: this.stockLocationId,
          quantity: this.available,
          threshold: this._lowStockThreshold,
        }),
      );
    }
  }

  private static assertNonNegative(field: string, value: number): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`StockLevel: ${field} must be a non-negative integer, got ${value}`);
    }
  }
}
```

A few rules made explicit here:

- The **per-mutation `version++`** lives in the aggregate, even though enforcement (the `WHERE version = ?` clause that detects conflicts) does not. The bump is "active but un-checked" — the column carries truthful contents from this commit; `epic-07` adds the check.
- The `lowStockThreshold` is set by the use case before a mutator is called and cleared after `pullDomainEvents()` is drained (the use case manages the lifecycle). The aggregate is threshold-agnostic by default, which means the spec can exercise mutator behavior without setting up a threshold every time.
- `pullDomainEvents()` returns and drains. The use case calls it inside the `IStockCachePort.withInvalidation(work, …)` work closure, **after** the repository UPDATE succeeds and **before** the cache invalidation fires. This means a UPDATE failure aborts the event emission, which is the desired post-commit ordering (ADR-023).

## Event files

`stock-received.event.ts`:

```ts
export interface IStockReceivedEventProps {
  variantId: number;
  stockLocationId: string;
  quantityDelta: number;
  newOnHand: number;
  actorId?: string;
}

export class StockReceivedEvent {
  public readonly variantId: number;
  public readonly stockLocationId: string;
  public readonly quantityDelta: number;
  public readonly newOnHand: number;
  public readonly actorId: string | null;
  public readonly occurredAt: Date;

  constructor(props: IStockReceivedEventProps) {
    this.variantId = props.variantId;
    this.stockLocationId = props.stockLocationId;
    this.quantityDelta = props.quantityDelta;
    this.newOnHand = props.newOnHand;
    this.actorId = props.actorId ?? null;
    this.occurredAt = new Date();
  }
}
```

`stock-adjusted.event.ts`: same shape plus `reasonCode: string`.

`stock-level-initialized.event.ts`: only `variantId`, `stockLocationId`, `occurredAt` — used by the auto-init consumer in task-07.

`stock-low.event.ts`: same shape as today (already exists) — rename `productId` to `variantId`. Keep `threshold` and `quantity` fields.

`stock-reserved.event.ts` and `stock-released.event.ts`: restructure to `variantId` + `stockLocationId` + `amount` shape. Both remain unused in this epic (no caller emits them); they exist so `epic-07` can import-and-emit without authoring a new event class.

## Domain spec for `StockLevel`

`apps/inventory-microservice/src/modules/stock/domain/spec/stock-level.model.spec.ts` — ≥15 cases:

1. constructs with a complete props bundle.
2. rejects negative `variantId`.
3. rejects zero `variantId`.
4. rejects empty `stockLocationId`.
5. rejects `stockLocationId` longer than 64 chars.
6. rejects negative quantities at construction.
7. rejects load-time invariant violation (allocated + reserved > onHand).
8. `available` derived getter returns onHand − allocated − reserved.
9. `receive` happy path increments onHand and bumps version.
10. `receive` rejects non-positive amount.
11. `receive` emits a `StockReceivedEvent` with `quantityDelta` and `newOnHand`.
12. `applySignedDelta` happy path (positive delta).
13. `applySignedDelta` happy path (negative delta).
14. `applySignedDelta` rejects zero delta.
15. `applySignedDelta` rejects missing `reasonCode`.
16. `applySignedDelta` rejects a delta that would drive `quantityOnHand` below zero.
17. `applySignedDelta` rejects a delta that would invalidate the allocated+reserved invariant.
18. `applySignedDelta` emits a `StockAdjustedEvent` carrying the `reasonCode`.
19. `pullDomainEvents` drains the internal buffer (calling twice returns `[]` on the second call).
20. `setLowStockThreshold` + `receive` below the threshold emits a `StockLowEvent` alongside the receive event.
21. `setLowStockThreshold(null)` then `receive` does not emit a `StockLowEvent` even at zero stock.

The spec is pure-domain — no repository mocks, no DI. Use plain `new StockLevel({...})` constructors and direct method calls.

## `domain/index.ts` update

Drop the `StockItem` export and the `Storage` export (already dropped by task-01 but verify). Add:

```ts
export { StockLevel, type IStockLevelProps, type IReceivePayload, type IApplySignedDeltaPayload } from './stock-level.model';
export { StockLocation, type IStockLocationProps, type StockLocationType } from './stock-location.model';
export {
  StockReceivedEvent,
  StockAdjustedEvent,
  StockLevelInitializedEvent,
  StockLowEvent,
  StockReservedEvent,
  StockReleasedEvent,
} from './events';
```

## Files to add

- `apps/inventory-microservice/src/modules/stock/domain/events/stock-received.event.ts`
- `apps/inventory-microservice/src/modules/stock/domain/events/stock-adjusted.event.ts`
- `apps/inventory-microservice/src/modules/stock/domain/events/stock-level-initialized.event.ts`
- `apps/inventory-microservice/src/modules/stock/domain/spec/stock-level.model.spec.ts`

## Files to modify

- `apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts` — placeholder replaced by the full aggregate.
- `apps/inventory-microservice/src/modules/stock/domain/events/stock-low.event.ts` — `productId` → `variantId`; add `stockLocationId`.
- `apps/inventory-microservice/src/modules/stock/domain/events/stock-reserved.event.ts` — `productId` → `variantId`; add `stockLocationId`. (Unused in this epic; restructured for epic-07.)
- `apps/inventory-microservice/src/modules/stock/domain/events/stock-released.event.ts` — same.
- `apps/inventory-microservice/src/modules/stock/domain/events/index.ts` — re-export the new event classes.
- `apps/inventory-microservice/src/modules/stock/domain/index.ts` — drop `StockItem`, add `StockLevel` + the new events.
- `docs/implementation/epic-04-inventory-stock-level-and-location/03-stocklevel-aggregate-and-version-column.md` — append the domain half.

## Files to delete

- `apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts`
- `apps/inventory-microservice/src/modules/stock/domain/spec/stock-item.model.spec.ts`

## Tests

- The new `stock-level.model.spec.ts` is the primary green-light here — ≥15 cases as enumerated.
- The pre-existing `stock-item.model.spec.ts` is deleted; no replacement is needed (the new spec covers the same ground at the new abstraction level).
- The persistence-layer spec from task-03 (`stock-typeorm.repository.spec.ts`) continues to pass — the mapper now hands round-tripped rows through the full aggregate's constructor.
- The three `describe.skip(...)`'d legacy use-case specs are still silent. Task-05 deletes them.
- `yarn build:inventory-microservice` succeeds.

## Doc deliverable

Append the **Domain Aggregate** half to `docs/implementation/epic-04-inventory-stock-level-and-location/03-stocklevel-aggregate-and-version-column.md`. Target ~120 additional lines. Sections appended:

1. **Aggregate shape.** The mutator surface (`receive(amount)` / `applySignedDelta(delta, reasonCode)`); the deferred mutators (`reserve(amount)` / `release(amount)`) are noted but not present, with a forward link to epic-07.
2. **Per-mutation `version` bump — active but un-checked.** Why the bump lives in the aggregate even though no check fires today: it gives the `@VersionColumn()` column truthful contents from this commit, so epic-07's retrofit (which adds `WHERE version = ?` to the UPDATE) is purely additive. The doc explicitly warns: "do not remove the bump as 'dead code' before epic-07 lands".
3. **The constructor's load-time invariant** (`allocated + reserved ≤ onHand`). Why it fires on load even when no mutator does today: the DB column defaults are zero, so the invariant trivially holds for any new row, but a malformed row from a partial restore or an out-of-band migration must fail fast at load time rather than silently mutate.
4. **The derived `available` getter.** Formula `onHand − allocated − reserved`. Cross-reference to the api-gateway projection shape (task-09 — same formula, computed server-side).
5. **Event emission contract.** `receive` always emits `StockReceivedEvent`; `applySignedDelta` always emits `StockAdjustedEvent`; both *may* additionally emit `StockLowEvent` if `setLowStockThreshold(t)` was called before the mutator. The use case (task-05) is responsible for the threshold lifecycle.
6. **`pullDomainEvents()` semantics.** Drain-on-read. The use case calls it inside the cache `withInvalidation` work closure, after the repository UPDATE returns the post-update row and before the prefix-delete fires. Sequencing diagram in ASCII for clarity.
7. **`StockReservedEvent` / `StockReleasedEvent` deferred.** Why the files exist on disk but no code path emits them in this epic: epic-07 owns the Reservation flow and will import-and-emit without authoring new classes.
8. **Forward links.** Task-05 (the use cases that call `receive` and `applySignedDelta`), task-07 (the consumer that constructs a fresh `StockLevel` with `quantityOnHand = 0` on `catalog.variant.created`), task-08 (the publisher that consumes `pullDomainEvents()`'s output and emits to RMQ).

## Carryover produced (consumed by task-05 onward)

- `StockLevel` full aggregate on disk with `receive` / `applySignedDelta` / `pullDomainEvents` / `setLowStockThreshold`.
- Three new event classes (`StockReceivedEvent`, `StockAdjustedEvent`, `StockLevelInitializedEvent`).
- Three restructured event classes (`StockLowEvent`, `StockReservedEvent`, `StockReleasedEvent` — `variantId`-keyed).
- `StockItem` model + spec gone from disk.
- Doc `03-stocklevel-aggregate-and-version-column.md` complete (persistence + domain halves both written).

## Exit criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; the new `stock-level.model.spec.ts` is green with ≥15 cases.
- [ ] `yarn build:inventory-microservice` succeeds.
- [ ] `git ls-files apps/inventory-microservice/src/modules/stock/domain/` shows `stock-level.model.ts` and `stock-location.model.ts` but not `stock-item.model.ts`.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `03-stocklevel-aggregate-and-version-column.md` has both the persistence half (from task-03) and the domain half (from this task) filled.
