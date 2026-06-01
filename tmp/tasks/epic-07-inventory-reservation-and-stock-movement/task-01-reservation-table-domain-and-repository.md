---
epic: epic-07
task_number: 1
title: Add reservation table + domain aggregate + repository
depends_on: [epic-04, epic-05]
doc_deliverable: docs/implementation/07-inventory-reservation-and-stock-movement/01-reservation-aggregate-and-q2-q9.md
---

# Task 01 — Add the `reservation` table + `Reservation` aggregate + repository

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** open the original ADRs:
  - [ADR-012](../../../docs/adr/012-stock-aggregate-and-port-adapter.md) — the `stock` bounded context; the existing repository/cache/publisher/transaction port quad that this task adds a sibling to.
  - [ADR-019](../../../docs/adr/019-typeorm-and-mysql-for-persistence.md) — entity/migration conventions; the cross-service FK-by-convention rule; `@VersionColumn`.
  - [ADR-004](../../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) — the domain/application/infrastructure split; `domain/` imports nothing framework-shaped.
  - [ADR-017](../../../docs/adr/017-architecture-lint-via-eslint-boundaries.md) — why the new aggregate slots into the existing module's `domain/` rather than a new module.

## Goal

Land the `Reservation` aggregate and its persistence so a cart can hold stock for a bounded TTL window. This task ships the **entity, the domain class, the mapper, the repository port + adapter, and the migration** — but **no use case** (Reserve/Release land in task-03). The domain spec asserts the TTL invariant and the status state machine at the aggregate level so the no-oversell guarantee has a tested foundation before the transactional use cases are written.

`Reservation` realizes **Open Question Q2** (an explicit Reservation entity, Saleor/Medusa style — not Vendure's allocation-only model) and **Open Question Q9** (TTL ~15 minutes, refreshed on cart writes, immediately committed on order placement). The TTL value comes from the env var `RESERVATION_TTL_MINUTES` (default `15`), but **this task does not read env** — it accepts `expiresAt` as a constructor input and defers env wiring to task-03's use case. The `version` column ships now (`@VersionColumn`) so the OCC enforcement task-03 adds is purely additive.

## Entry state assumed

`epic-04` + `epic-05` merged:

- The `stock` module exists at `apps/inventory-microservice/src/modules/stock/` with `StockLevel`, `StockLocation`, the `STOCK_REPOSITORY` / `STOCK_CACHE` / `STOCK_EVENTS_PUBLISHER` / `TRANSACTION_PORT` quad, and the `v2` cache key.
- `stock_level` carries `quantityReserved` / `quantityAllocated` columns at default `0` (written, never mutated yet).
- `stock_location` exists with the seeded `default-warehouse` row.
- No `reservation` table exists.

## Scope

**In:**

- Domain aggregate `…/stock/domain/reservation.model.ts` — `Reservation` (plain class, not `AggregateRoot`; matches `StockLevel`'s style per ADR-012 — events are emitted from the use case post-commit, not pulled from the aggregate).
- New domain error subclasses: `ReservationNotFoundError`, `ReservationExpiredError`, `InvalidReservationTransitionError` (extend the existing inventory domain error base; if none exists, add `InventoryDomainError` as the base alongside).
- `ReservationStatusEnum` (`active | committed | released | expired`) in `…/stock/domain/`.
- Entity `…/infrastructure/persistence/reservation.entity.ts` — `CHAR(36)` UUID PK, `@VersionColumn`, the indexes below.
- Mapper `…/infrastructure/persistence/reservation.mapper.ts`.
- Repository port `…/application/ports/reservation.repository.port.ts` + `RESERVATION_REPOSITORY` symbol.
- Repository adapter `…/infrastructure/persistence/reservation-typeorm.repository.ts` (extends `BaseTypeormRepository`).
- Migration `migrations/<timestamp>-CreateReservationTable.ts`.
- Domain spec `…/stock/domain/spec/reservation.model.spec.ts`.
- `stock.module.ts` registers the entity + binds `RESERVATION_REPOSITORY`.
- Doc deliverable `01-reservation-aggregate-and-q2-q9.md`.

**Out:**

- Reserve / Release use cases — task-03.
- The `@VersionColumn` *enforcement* (retry-then-409) — task-03's use case.
- `StockMovement` — task-02.
- Any RMQ wiring / events — task-03.
- The TTL sweeper job that flips `active`→`expired` by wall clock — `epic-14`.

## Domain shape

`apps/inventory-microservice/src/modules/stock/domain/reservation.model.ts`:

```ts
import { ReservationStatusEnum } from './reservation-status.enum';
import { InvalidReservationTransitionError } from './errors/invalid-reservation-transition.error';

export interface IReservationProps {
  id: string; // UUID; assigned by the use case (uuid v4) before first save
  variantId: number;
  stockLocationId: string;
  quantity: number;
  cartId: string; // opaque from inventory's perspective — references retail-side cart.id
  expiresAt: Date;
  status?: ReservationStatusEnum;
  version?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export class Reservation {
  public readonly id: string;
  public readonly variantId: number;
  public readonly stockLocationId: string;
  public readonly cartId: string;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private _quantity: number;
  private _expiresAt: Date;
  private _status: ReservationStatusEnum;
  private _version: number;

  constructor(props: IReservationProps) {
    if (props.quantity <= 0) {
      throw new InvalidReservationTransitionError('Reservation quantity must be positive');
    }
    this.id = props.id;
    this.variantId = props.variantId;
    this.stockLocationId = props.stockLocationId;
    this.cartId = props.cartId;
    this._quantity = props.quantity;
    this._expiresAt = props.expiresAt;
    this._status = props.status ?? ReservationStatusEnum.Active;
    this._version = props.version ?? 0;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  public get quantity(): number { return this._quantity; }
  public get expiresAt(): Date { return this._expiresAt; }
  public get status(): ReservationStatusEnum { return this._status; }
  public get version(): number { return this._version; }

  public isExpiredAt(now: Date): boolean {
    return this._expiresAt.getTime() < now.getTime();
  }

  /** Idempotent refresh on a repeated Add-to-Cart for the same (cartId, variantId). */
  public refresh(quantity: number, expiresAt: Date): void {
    this.assertActive();
    if (quantity <= 0) {
      throw new InvalidReservationTransitionError('Reservation quantity must be positive');
    }
    this._quantity = quantity;
    this._expiresAt = expiresAt;
  }

  public release(): void {
    this.assertActive();
    this._status = ReservationStatusEnum.Released;
  }

  public expire(): void {
    this.assertActive();
    this._status = ReservationStatusEnum.Expired;
  }

  /** Allocate-on-place: active → committed. Rejects an expired reservation. */
  public commit(now: Date): void {
    this.assertActive();
    if (this.isExpiredAt(now)) {
      this._status = ReservationStatusEnum.Expired;
      throw new InvalidReservationTransitionError('Cannot commit an expired reservation');
    }
    this._status = ReservationStatusEnum.Committed;
  }

  private assertActive(): void {
    if (this._status !== ReservationStatusEnum.Active) {
      throw new InvalidReservationTransitionError(
        `Reservation ${this.id} is ${this._status}; only an active reservation can transition`,
      );
    }
  }
}
```

> The aggregate carries the status *state machine* and the TTL check, but it does **not** mutate `stock_level.quantityReserved` — that side-effect is the use case's job inside a transaction (task-03). Keeping the aggregate side-effect-free is what lets the domain spec run with zero infrastructure.

## Persistence shape

### `reservation.entity.ts`

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';

@Entity('reservation')
@Index('uq_reservation_cart_variant_location', ['cartId', 'variantId', 'stockLocationId'], {
  unique: true,
})
@Index('idx_reservation_expires_at', ['expiresAt'])
@Index('idx_reservation_status_expires_at', ['status', 'expiresAt'])
export class ReservationEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  public id: string;

  @Column({ type: 'int' })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({ type: 'int' })
  public quantity: number;

  @Column({ type: 'char', length: 36 })
  public cartId: string;

  @Column({ type: 'timestamp' })
  public expiresAt: Date;

  @Column({ type: 'enum', enum: ['active', 'committed', 'released', 'expired'], default: 'active' })
  public status: string;

  @VersionColumn({ type: 'int', default: 0 })
  public version: number;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
```

- The **unique index `(cart_id, variant_id, stock_location_id)`** is the idempotency anchor: a repeated Add-to-Cart for the same triple updates the existing row rather than inserting a second (task-03 leans on this with `INSERT … ON DUPLICATE KEY UPDATE` semantics or a find-then-refresh).
- The two `expires_at` indexes (`(expires_at)` and `(status, expires_at)`) exist for `epic-14`'s sweeper. They are unused in this epic — created now so the sweeper retrofit is non-destructive.
- `variant_id` is **not** a SQL FK to `product_variant` (catalog-owned; ADR-019 keeps each microservice's tables schema-private). `cart_id` is likewise opaque — it references `cart.id` in retail-microservice with no SQL `REFERENCES`.

### `reservation.mapper.ts`

Round-trips `ReservationEntity` ↔ `Reservation` domain. `toDomain` reads `status` as `ReservationStatusEnum`; `toEntity` writes the string value. Match the name-aliasing convention used by `StockLevelMapper` / `StockLocationMapper` from `epic-04`.

### Repository port

`…/application/ports/reservation.repository.port.ts`:

```ts
import { Reservation } from '../../domain';
import { ITransactionScope } from './transaction.port';

export const RESERVATION_REPOSITORY = Symbol('RESERVATION_REPOSITORY');

export interface IReservationRepositoryPort {
  findByCartVariantLocation(
    cartId: string,
    variantId: number,
    stockLocationId: string,
    scope?: ITransactionScope,
  ): Promise<Reservation | null>;

  /** All reservations for a cart (used by Release-all on cart abandonment). */
  findActiveByCart(cartId: string, scope?: ITransactionScope): Promise<Reservation[]>;

  findById(id: string, scope?: ITransactionScope): Promise<Reservation | null>;

  save(reservation: Reservation, scope?: ITransactionScope): Promise<Reservation>;
}
```

Every method takes the optional `ITransactionScope` (ADR-012/ADR-017 — the application layer never touches `EntityManager`; the scope is the opaque token the `TypeormTransactionAdapter` constructs). The repository adapter downcasts the scope inside `infrastructure/persistence/` only.

## Migration

`migrations/<timestamp>-CreateReservationTable.ts`:

`up()`:
1. `CREATE TABLE reservation` with the column shape above (`id` `CHAR(36)` PK; `status` ENUM; `version` INT default 0; `created_at`/`updated_at` timestamps).
2. `CREATE UNIQUE INDEX uq_reservation_cart_variant_location ON reservation (cart_id, variant_id, stock_location_id)`.
3. `CREATE INDEX idx_reservation_expires_at ON reservation (expires_at)`.
4. `CREATE INDEX idx_reservation_status_expires_at ON reservation (status, expires_at)`.

`down()`: `DROP TABLE reservation`.

The table is **created empty** — reservations are runtime-only (live ephemeral; purged after `released`/`expired` + retention window, a future hardening item). No seed rows.

## Files to add

- `apps/inventory-microservice/src/modules/stock/domain/reservation.model.ts`
- `apps/inventory-microservice/src/modules/stock/domain/reservation-status.enum.ts`
- `apps/inventory-microservice/src/modules/stock/domain/errors/{reservation-not-found,reservation-expired,invalid-reservation-transition}.error.ts` (+ an `InventoryDomainError` base if one does not already exist)
- `apps/inventory-microservice/src/modules/stock/domain/spec/reservation.model.spec.ts`
- `apps/inventory-microservice/src/modules/stock/application/ports/reservation.repository.port.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/reservation.entity.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/reservation.mapper.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/reservation-typeorm.repository.ts`
- `migrations/<timestamp>-CreateReservationTable.ts`
- `docs/implementation/07-inventory-reservation-and-stock-movement/01-reservation-aggregate-and-q2-q9.md`

## Files to modify

- `…/stock/domain/index.ts` — export `Reservation`, `ReservationStatusEnum`, the new errors.
- `…/stock/application/ports/index.ts` — re-export `IReservationRepositoryPort` + `RESERVATION_REPOSITORY`.
- `…/stock/infrastructure/persistence/index.ts` — re-export the new entity + mapper + repository.
- `…/stock/infrastructure/stock.module.ts` — `DatabaseModule.forFeature([…, ReservationEntity])`; add `ReservationTypeormRepository` provider + `{ provide: RESERVATION_REPOSITORY, useExisting: ReservationTypeormRepository }`.

## Files to delete

None.

## Tests

`reservation.model.spec.ts`:

- Constructor rejects `quantity <= 0` (`InvalidReservationTransitionError`).
- `isExpiredAt(now)` true when `now > expiresAt`, false otherwise.
- `refresh(qty, expiresAt)` on an active reservation updates both; on a non-active reservation throws.
- `release()` / `expire()` flip an active reservation; calling either twice (or on a committed one) throws `InvalidReservationTransitionError`.
- `commit(now)` on a non-expired active reservation → `committed`; on an expired active reservation throws `InvalidReservationTransitionError` **and** leaves the reservation `expired` (the spec asserts both the throw and the resulting status).

`yarn migration:run` against a post-`epic-04` DB creates `reservation` with the unique + two secondary indexes (assert via `SHOW INDEX FROM reservation`).

## Doc deliverable — `01-reservation-aggregate-and-q2-q9.md`

Target ~150 lines. Sections:

1. **Open Question Q2 — why an explicit Reservation entity.** Restate the trade-off: Vendure allocates only at checkout completion (simpler, fewer rows) but cannot stop two carts racing for the last unit before checkout. Saleor/Medusa hold an explicit reservation on add-to-cart. Modern UX ("1 left!") expects the latter; this epic delivers it.
2. **Open Question Q9 — the TTL contract.** ~15 minutes (`RESERVATION_TTL_MINUTES`, default `15`); refreshed on every cart write (Add/Change re-stamp `expiresAt`); committed immediately on order placement. Note that the *env wiring* lands in task-03 and the *wall-clock sweeper* in `epic-14`; this task ships the entity + the inline `isExpiredAt` check used by allocate-time validation.
3. **The status state machine.** `active → {released, expired, committed}`; all three are terminal. A diagram (text) of the transitions and which operation triggers each.
4. **Idempotency at `(cartId, variantId, stockLocationId)`.** Why this triple is the unique key; how a repeated Add-to-Cart refreshes rather than duplicates.
5. **The `@VersionColumn` OCC token — why it ships now.** The no-oversell race surface arrives with Reservation (this epic), so the OCC enforcement lands in task-03 — but the column ships in this task so the entity is whole. Mechanically: TypeORM bumps `version` on every `save()` UPDATE; task-03's use case reads-checks-writes inside a transaction and retries on version mismatch.
6. **Live-ephemeral lifecycle.** Reservation is purged after `released`/`expired` + a retention window (a future hardening item) — contrast with StockMovement (doc `02-…`), which is append-only forever.
7. **What this task did NOT do.** Forward links to task-03 (Reserve/Release use cases + env-driven TTL + OCC retry), task-04 (allocate consumes `commit()`), `epic-14` (the sweeper).

## Carryover produced (consumed by task-02 onward)

- `reservation` table exists with the unique + two secondary indexes; `version` column ships from this commit.
- `Reservation` aggregate + `ReservationStatusEnum` + the three errors on disk; the mapper round-trips the entity.
- `IReservationRepositoryPort` + `RESERVATION_REPOSITORY` bound in `stock.module.ts`.
- Doc `01-reservation-aggregate-and-q2-q9.md` exists.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `reservation.model.spec.ts` green.
- [ ] `yarn build:inventory-microservice` succeeds.
- [ ] `yarn migration:run` creates `reservation`; `SHOW INDEX FROM reservation` reports the unique `(cart_id, variant_id, stock_location_id)` + the two `expires_at` indexes; `yarn migration:revert` drops it cleanly.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `01-reservation-aggregate-and-q2-q9.md` exists with the sections above.
