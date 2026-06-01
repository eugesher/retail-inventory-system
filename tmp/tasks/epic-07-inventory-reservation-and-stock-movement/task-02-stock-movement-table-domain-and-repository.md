---
epic: epic-07
task_number: 2
title: Add stock_movement table + domain + append-only repository
depends_on: [01]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/02-stock-movement-typed-ledger.md
---

# Task 02 — Add the `stock_movement` typed ledger + append-only repository

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-012](../../../docs/adr/012-stock-aggregate-and-port-adapter.md) — the `stock` bounded context; `StockMovement` is a sibling persistence concern, not a new module.
  - [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) — BIGINT PK, composite-index conventions, migration shape.
  - [ADR-017](../../../docs/adr/017-architecture-lint-via-eslint-boundaries.md) — the append-only constraint is reviewed in `spec/architecture-lint.spec.ts` (task-13 wires the fixture).
  - [ADR-001](../../../docs/adr/001-structured-logging-with-pino.md) — `PinoLogger`; no `@nestjs/common` `Logger`.

## Goal

Land the typed, **append-only** `StockMovement` ledger. Every stock-changing operation in the system records a `StockMovement` row: `receipt`, `adjustment`, `allocation`, `sale`, `release`, `return`. The row carries a *signed* quantity and a *polymorphic* `referenceType`/`referenceId` (e.g. `cart`/`<cartId>`, `order`/`<orderId>`, `return-request`/<id>`). This task ships the **entity, domain class, mapper, the append-only repository port + adapter, and the migration** — the use cases that *write* movements arrive in tasks 03–07; this task gives them a typed insert surface.

The defining property is **append-only by construction**: the repository port exposes `append(...)` and read methods, but **no `update` and no `delete`**. The aggregate exposes no mutator. This is enforced three ways: (1) the port surface has no mutation method; (2) the entity declares no `@UpdateDateColumn` (a movement is never updated); (3) `spec/architecture-lint.spec.ts` gets a fixture in task-13 asserting no `UPDATE`/`DELETE` against `stock_movement`.

## Entry state assumed

Task-01 carryover present:

- `reservation` table + `Reservation` aggregate + `RESERVATION_REPOSITORY` bound.
- The `InventoryDomainError` base exists (added in task-01 if it did not already).
- No `stock_movement` table exists.

## Scope

**In:**

- `StockMovementTypeEnum` (`receipt | adjustment | allocation | sale | release | return`) in `…/stock/domain/`.
- Domain class `…/stock/domain/stock-movement.model.ts` — `StockMovement` (plain immutable class; a `static record(...)` factory enforces the signed-quantity rules per type; **no instance mutator**).
- Entity `…/infrastructure/persistence/stock-movement.entity.ts` — BIGINT PK, `occurred_at` default `CURRENT_TIMESTAMP`, the two composite indexes; **no `@UpdateDateColumn`**.
- Mapper `…/infrastructure/persistence/stock-movement.mapper.ts`.
- Repository port `…/application/ports/stock-movement.repository.port.ts` + `STOCK_MOVEMENT_REPOSITORY` symbol — `append` + paginated reads only.
- Repository adapter `…/infrastructure/persistence/stock-movement-typeorm.repository.ts`.
- Migration `migrations/<timestamp>-CreateStockMovementTable.ts`.
- Domain spec `…/stock/domain/spec/stock-movement.model.spec.ts`.
- `stock.module.ts` registers the entity + binds `STOCK_MOVEMENT_REPOSITORY`.
- Doc deliverable `02-stock-movement-typed-ledger.md`.

**Out:**

- Use cases that write movements (Reserve/Release/Allocate/Cancel/Receive/Adjust/Transfer) — tasks 03–07.
- The `inventory.stock-movement.recorded` event emit — task-03 (the publisher-port method ships there; the *call* is added per writing use case).
- The audit read *endpoint* (`GET /…/movements`) — task-09 (this task ships the repository read method it calls).
- The arch-lint fixture asserting append-only — task-13 (this task ships the no-mutation port surface it verifies).

## Domain shape

`apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts`:

```ts
import { StockMovementTypeEnum } from './stock-movement-type.enum';
import { InventoryDomainError } from './errors/inventory-domain.error';

export interface IStockMovementProps {
  id?: number | null; // BIGINT — assigned by the DB on insert
  variantId: number;
  stockLocationId: string;
  type: StockMovementTypeEnum;
  quantity: number; // signed; sign is validated against `type`
  reasonCode?: string | null;
  referenceType?: string | null; // e.g. 'cart' | 'order' | 'return-request'
  referenceId?: string | null;
  actorId?: string | null; // null === System actor
  occurredAt?: Date | null;
}

// Sign rule per type: receipt/return add; sale/allocation/release remove;
// adjustment is genuinely signed (a stock-take can correct up or down).
const POSITIVE_ONLY: ReadonlySet<StockMovementTypeEnum> = new Set([
  StockMovementTypeEnum.Receipt,
  StockMovementTypeEnum.Return,
]);
const NEGATIVE_ONLY: ReadonlySet<StockMovementTypeEnum> = new Set([
  StockMovementTypeEnum.Sale,
  StockMovementTypeEnum.Allocation,
  StockMovementTypeEnum.Release,
]);

export class StockMovement {
  public readonly id: number | null;
  public readonly variantId: number;
  public readonly stockLocationId: string;
  public readonly type: StockMovementTypeEnum;
  public readonly quantity: number;
  public readonly reasonCode: string | null;
  public readonly referenceType: string | null;
  public readonly referenceId: string | null;
  public readonly actorId: string | null;
  public readonly occurredAt: Date | null;

  // Private — construction is through `record(...)` so the sign rule cannot be bypassed.
  private constructor(props: IStockMovementProps) {
    this.id = props.id ?? null;
    this.variantId = props.variantId;
    this.stockLocationId = props.stockLocationId;
    this.type = props.type;
    this.quantity = props.quantity;
    this.reasonCode = props.reasonCode ?? null;
    this.referenceType = props.referenceType ?? null;
    this.referenceId = props.referenceId ?? null;
    this.actorId = props.actorId ?? null;
    this.occurredAt = props.occurredAt ?? null;
  }

  public static record(props: IStockMovementProps): StockMovement {
    if (props.quantity === 0) {
      throw new InventoryDomainError('StockMovement quantity must be non-zero');
    }
    if (POSITIVE_ONLY.has(props.type) && props.quantity < 0) {
      throw new InventoryDomainError(`${props.type} movement must have a positive quantity`);
    }
    if (NEGATIVE_ONLY.has(props.type) && props.quantity > 0) {
      throw new InventoryDomainError(`${props.type} movement must have a negative quantity`);
    }
    // adjustment: any non-zero sign is legal.
    return new StockMovement(props);
  }

  /** Rehydrate from persistence without re-running the sign guard (the row is trusted). */
  public static fromPersistence(props: IStockMovementProps): StockMovement {
    return new StockMovement(props);
  }
}
```

> There is deliberately **no instance method that changes a field** — once recorded, a movement is frozen. This is the domain-level half of the append-only guarantee; the repository (below) is the persistence-level half.

## Persistence shape

### `stock-movement.entity.ts`

```ts
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('stock_movement')
@Index('idx_stock_movement_variant_occurred', ['variantId', 'occurredAt'])
@Index('idx_stock_movement_reference', ['referenceType', 'referenceId'])
export class StockMovementEntity {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  public id: number;

  @Column({ type: 'int' })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({
    type: 'enum',
    enum: ['receipt', 'adjustment', 'allocation', 'sale', 'release', 'return'],
  })
  public type: string;

  @Column({ type: 'int' })
  public quantity: number; // signed

  @Column({ type: 'varchar', length: 64, nullable: true })
  public reasonCode: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  public referenceType: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public referenceId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public actorId: string | null;

  // No @UpdateDateColumn — movements are never updated. occurredAt defaults
  // to insert-time but the use case may pass an explicit value.
  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  public occurredAt: Date;
}
```

- BIGINT PK — `stock_movement` is the highest-cardinality inventory table (every receive/adjust/reserve-commit/allocate/sale/release/return inserts a row), so it diverges from `BaseEntity`'s INT-PK default. Note this divergence in the doc so a reader isn't surprised the entity declares its own PK.
- `idx_stock_movement_variant_occurred (variant_id, occurred_at)` is the exact access path for task-09's audit read (`WHERE variant_id = ? ORDER BY occurred_at DESC`).
- `idx_stock_movement_reference (reference_type, reference_id)` supports "all movements for this order/cart" lookups.

### Repository port — append + read, never mutate

`…/application/ports/stock-movement.repository.port.ts`:

```ts
import { IPage, IPageRequest } from '@retail-inventory-system/common';

import { StockMovement } from '../../domain';
import { StockMovementTypeEnum } from '../../domain';
import { ITransactionScope } from './transaction.port';

export const STOCK_MOVEMENT_REPOSITORY = Symbol('STOCK_MOVEMENT_REPOSITORY');

export interface IStockMovementQuery extends IPageRequest {
  variantId: number;
  type?: StockMovementTypeEnum;
  from?: Date;
  to?: Date;
}

export interface IStockMovementRepositoryPort {
  /**
   * Append one movement. Participates in the caller's transaction when a scope
   * is passed (so the movement and the StockLevel mutation commit atomically).
   * There is intentionally NO update/delete on this port — the ledger is
   * append-only by construction (see ADR-017 + the arch-lint fixture).
   */
  append(movement: StockMovement, scope?: ITransactionScope): Promise<StockMovement>;

  /** Append several movements in one round-trip (Transfer writes two). */
  appendMany(movements: StockMovement[], scope?: ITransactionScope): Promise<StockMovement[]>;

  /** Paginated audit read — the access path for task-09's endpoint. */
  query(query: IStockMovementQuery): Promise<IPage<StockMovement>>;
}
```

The adapter implements `append`/`appendMany` as `INSERT`s and `query` as a paginated `SELECT … ORDER BY occurred_at DESC`. **No method issues `UPDATE` or `DELETE` against `stock_movement`** — task-13's arch-lint fixture greps for this.

## Migration

`migrations/<timestamp>-CreateStockMovementTable.ts`:

`up()`:
1. `CREATE TABLE stock_movement` (BIGINT PK; `type` ENUM; `quantity` INT signed; `reason_code` VARCHAR(64) NULL; `reference_type` VARCHAR(32) NULL; `reference_id` VARCHAR(64) NULL; `actor_id` VARCHAR(64) NULL; `occurred_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP).
2. `CREATE INDEX idx_stock_movement_variant_occurred ON stock_movement (variant_id, occurred_at)`.
3. `CREATE INDEX idx_stock_movement_reference ON stock_movement (reference_type, reference_id)`.

`down()`: `DROP TABLE stock_movement`.

Created empty.

## Files to add

- `…/stock/domain/stock-movement.model.ts`
- `…/stock/domain/stock-movement-type.enum.ts`
- `…/stock/domain/spec/stock-movement.model.spec.ts`
- `…/stock/application/ports/stock-movement.repository.port.ts`
- `…/stock/infrastructure/persistence/stock-movement.entity.ts`
- `…/stock/infrastructure/persistence/stock-movement.mapper.ts`
- `…/stock/infrastructure/persistence/stock-movement-typeorm.repository.ts`
- `migrations/<timestamp>-CreateStockMovementTable.ts`
- `docs/implementation/07-inventory-reservation-and-stock-movement/02-stock-movement-typed-ledger.md`

## Files to modify

- `…/stock/domain/index.ts` — export `StockMovement`, `StockMovementTypeEnum`.
- `…/stock/application/ports/index.ts` — re-export `IStockMovementRepositoryPort` + `STOCK_MOVEMENT_REPOSITORY` + `IStockMovementQuery`.
- `…/stock/infrastructure/persistence/index.ts` — re-export the new entity + mapper + repository.
- `…/stock/infrastructure/stock.module.ts` — `DatabaseModule.forFeature([…, StockMovementEntity])`; add the repository provider + `{ provide: STOCK_MOVEMENT_REPOSITORY, useExisting: StockMovementTypeormRepository }`.

## Files to delete

None.

## Tests

`stock-movement.model.spec.ts`:

- `record({ type: receipt, quantity: 5 })` ok; `quantity: -5` rejected (`InventoryDomainError`).
- `record({ type: return, quantity: 3 })` ok; negative rejected.
- `record({ type: sale, quantity: -2 })` ok; positive rejected. Same for `allocation`, `release`.
- `record({ type: adjustment, quantity: -4 })` and `quantity: 4` both ok (genuinely signed); `quantity: 0` rejected for every type.
- The class exposes **no mutator** — a test asserts there is no `update`/`setQuantity`-style method (e.g. `expect((StockMovement.prototype as Record<string, unknown>).update).toBeUndefined()`), documenting the append-only intent.

`yarn migration:run` creates `stock_movement` with both composite indexes (`SHOW INDEX FROM stock_movement`).

## Doc deliverable — `02-stock-movement-typed-ledger.md`

Target ~150 lines. Sections:

1. **The six movement types and what triggers each.** Table: `receipt` (Receive Stock), `adjustment` (Adjust Stock / stock-take), `allocation` (Allocate on Place), `sale` (Commit Sale — `epic-08`), `release` (Release Reservation / Cancel Allocation), `return` (Restock from Return — `epic-09`). Which epic owns the producer for each.
2. **Signed-quantity rules.** Positive-only (`receipt`, `return`), negative-only (`sale`, `allocation`, `release`), and genuinely-signed (`adjustment`). Why a *signed* ledger over two unsigned columns: a single `SUM(quantity)` over the ledger reconstructs net movement; the sign carries the direction.
3. **Polymorphic reference.** `referenceType` + `referenceId` (no FK — a single column can't reference `cart`, `order`, and `return-request`). The conventional values; how task-09's `(reference_type, reference_id)` index serves "all movements for order X".
4. **Append-only by construction.** Three enforcement layers: the domain class has no mutator + a private constructor behind `record(...)`; the repository port has only `append`/`appendMany`/`query`; the arch-lint fixture (task-13) asserts no `UPDATE`/`DELETE` reaches `stock_movement`. Cross-Cutting "Auditability" + "Soft delete vs hard delete" (StockMovement is *never* deleted, contrast Reservation's live-ephemeral lifecycle in doc `01-…`).
5. **BIGINT PK rationale.** Highest-cardinality inventory table; BIGINT headroom over the INT-PK `BaseEntity` default; the explicit PK declaration is intentional.
6. **`actorId` and the System actor.** `null` means a System-triggered movement (Reserve/Allocate/Release run as System); user-triggered Receive/Adjust/Transfer carry the staff user id. Forward link to `epic-11`'s event-store consumer of `inventory.stock-movement.recorded`.
7. **What this task did NOT do.** Forward links to tasks 03–07 (the writers), task-09 (the audit endpoint), task-13 (the arch-lint fixture).

## Carryover produced (consumed by task-03 onward)

- `stock_movement` table exists with the two composite indexes.
- `StockMovement` aggregate + `StockMovementTypeEnum` + the `record`/`fromPersistence` factories on disk.
- `IStockMovementRepositoryPort` (`append`/`appendMany`/`query`) + `STOCK_MOVEMENT_REPOSITORY` bound in `stock.module.ts`.
- Doc `02-stock-movement-typed-ledger.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `stock-movement.model.spec.ts` green (sign rules + no-mutator assertion).
- [ ] `yarn build:inventory-microservice` succeeds.
- [ ] `yarn migration:run` creates `stock_movement` with both composite indexes; `yarn migration:revert` drops it cleanly.
- [ ] The `IStockMovementRepositoryPort` surface contains no `update`/`delete` method.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `02-stock-movement-typed-ledger.md` exists with the sections above.
