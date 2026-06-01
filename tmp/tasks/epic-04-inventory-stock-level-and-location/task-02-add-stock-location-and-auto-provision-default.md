---
epic: epic-04
task_number: 2
title: Add stock_location + auto-provision the default-warehouse row
depends_on: [01]
doc_deliverable: docs/implementation/04-inventory-stock-level-and-location/02-default-stocklocation-auto-provision.md
---

# Task 02 — Add `stock_location` + auto-provision the default warehouse

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Introduce the `StockLocation` aggregate (replacing the deleted `Storage` model) end-to-end: domain model + spec, TypeORM entity + mapper, repository methods, and a migration that **creates the `stock_location` table and idempotently inserts the single seeded row** `id = 'default-warehouse'`, `code = 'DEFAULT-WAREHOUSE'`, `type = 'warehouse'`, `active = true`. This is Open Question Q8 made concrete (one default, auto-provisioned at install). The repository surface is small in this task — `findById`, `findByCode`, `list({ activeOnly })`, `save` — because no use case touches it yet; tasks 05 + 09 add the read endpoint.

The `StockLocation` aggregate is the first new domain class to land. It is intentionally simple: it has no event-emission responsibilities (location creation is not a domain event in this epic) and no concurrency guard (`code` uniqueness is enforced at the DB level; soft-deactivation flips `active` to `false`, never `deletedAt`). The hard rule documented in this task: **`stock_location` rows are never hard-deleted**.

## Entry state assumed

Task-01 carryover present:

- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/` no longer contains any `*.entity.ts` files; only `stock-typeorm.repository.ts` (throwing stub), `typeorm-transaction.adapter.ts`, and `index.ts`.
- `apps/inventory-microservice/src/modules/stock/domain/` no longer contains `storage.model.ts`.
- `stock.module.ts` calls `DatabaseModule.forFeature([])`.
- The MySQL schema has no `product`, `product_stock`, `product_stock_action`, or `storage` table.

## Scope

**In:**

- New domain class `apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts` plus its spec under `domain/spec/stock-location.model.spec.ts`.
- New TypeORM entity `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-location.entity.ts`.
- New mapper `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-location.mapper.ts`.
- Extend `StockTypeormRepository` with the four `StockLocation` methods (still implementing the throwing-stub for the `StockItem`-shaped methods until task-05). The repository keeps its single class identity — it grows a second port surface, `IStockLocationRepositoryPort`, and the class implements both. Alternatively, split into a separate `StockLocationTypeormRepository` class; the task documents the trade-off and lands on the single-class approach because the repository is one EntityManager-bound unit and splitting forces extra DI plumbing.
- New port `apps/inventory-microservice/src/modules/stock/application/ports/stock-location.repository.port.ts` with the interface + DI token `STOCK_LOCATION_REPOSITORY`. Exported through `application/ports/index.ts`.
- New migration `migrations/<timestamp>-CreateStockLocationTableAndSeedDefault.ts`. Creates the table and inserts the seeded row in the same `up()` call — the seed is part of the migration, not a separate `scripts/seeds/*.sql` file, so production deploys and test bootstraps share the same code path.
- `stock.module.ts` updated to `DatabaseModule.forFeature([StockLocation])` and to register the new port-to-implementation binding.
- Doc deliverable `02-default-stocklocation-auto-provision.md`.

**Out:**

- The `stock_level` table — task-03.
- Any use case that touches `StockLocation` — task-05 (the `Receive Stock` precondition "location active" reads it).
- An api-gateway `GET /api/inventory/locations` endpoint — task-09.
- A second seeded location for tests — none is added; the test seed (task-10) does not introduce a second location.

## `apps/inventory-microservice/.../domain/stock-location.model.ts`

The domain shape:

```ts
export type StockLocationType = 'warehouse' | 'store' | 'dropship-virtual';

export interface IStockLocationProps {
  id: string;
  name: string | null;
  code: string;
  type: StockLocationType;
  address?: Record<string, unknown> | null;
  gln?: string | null;
  active?: boolean;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

export class StockLocation {
  public readonly id: string;
  public readonly code: string;
  public readonly type: StockLocationType;
  public readonly gln: string | null;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;
  private _name: string | null;
  private _address: Record<string, unknown> | null;
  private _active: boolean;

  constructor(props: IStockLocationProps) {
    // Invariants (asserted in the spec):
    //   * id is a non-empty string (≤ 64 chars; matches the VARCHAR PK).
    //   * code is a non-empty string, uppercased, alphanumeric + hyphen,
    //     length ≤ 64.
    //   * type ∈ {'warehouse','store','dropship-virtual'}.
    //   * gln, if present, is exactly 13 digits (the GS1 standard length).
    //   * address, if present, is a plain object — invariant only validates
    //     the type tag, not the shape (no postal schema enforced here).
    // … assertions go here, throwing Error with self-describing messages.
  }

  public get name(): string | null { return this._name; }
  public get address(): Record<string, unknown> | null { return this._address; }
  public get active(): boolean { return this._active; }

  public deactivate(): void {
    if (!this._active) return; // idempotent
    this._active = false;
  }

  public activate(): void {
    if (this._active) return;
    this._active = true;
  }

  public rename(name: string | null): void {
    // Trim, allow empty-as-null. Type-only enforcement here.
    this._name = name && name.trim().length > 0 ? name.trim() : null;
  }

  public updateAddress(address: Record<string, unknown> | null): void {
    this._address = address ?? null;
  }
}
```

No `delete()` method. Soft-delete is via `deactivate()` (the epic's "Architectural Decisions Honored" §"Soft delete vs hard delete" rule). No `version` column on the model — `StockLocation` is not concurrency-sensitive in this epic (writes are admin-only and infrequent); the optimistic-concurrency token lives on `StockLevel`.

## `apps/inventory-microservice/.../domain/spec/stock-location.model.spec.ts`

Test cases (at least 12 distinct `it()` blocks):

1. constructs with a complete props bundle.
2. rejects empty `id`.
3. rejects `id` longer than 64 chars.
4. rejects empty `code`.
5. rejects mixed-case `code` (must be uppercased on input — or, alternatively, the constructor uppercases silently; pick the silent-uppercase variant and assert it).
6. rejects `code` containing whitespace or punctuation other than `-`.
7. rejects `type` outside the enum.
8. rejects `gln` that is not 13 digits.
9. accepts `gln === null`.
10. `deactivate()` is idempotent.
11. `activate()` is idempotent.
12. `rename(' ')` collapses to `null`.

Test cases here are pure-domain — no repository mock, no DI, no async. Follow the pattern in the existing `stock-item.model.spec.ts` (which is deleted in task-04 but the structure is the reference).

## `apps/inventory-microservice/.../infrastructure/persistence/stock-location.entity.ts`

```ts
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('stock_location')
export class StockLocation {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  public id: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  public name: string | null;

  // Unique index added below as a class-level @Index — TypeORM's column-level
  // unique:true is also acceptable here; pick whichever matches the existing
  // entity style in the repo.
  @Column({ type: 'varchar', length: 64 })
  public code: string;

  @Column({ type: 'enum', enum: ['warehouse', 'store', 'dropship-virtual'] })
  public type: 'warehouse' | 'store' | 'dropship-virtual';

  @Column({ type: 'json', nullable: true })
  public address: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 13, nullable: true })
  public gln: string | null;

  @Column({ type: 'boolean', default: true })
  public active: boolean;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
```

Class-level `@Index('uq_stock_location_code', ['code'], { unique: true })` added so the migration generator sees it. (If the migration is hand-written, name the index explicitly in the migration body to match this class decorator.)

## `apps/inventory-microservice/.../infrastructure/persistence/stock-location.mapper.ts`

Two functions: `toDomain(entity: StockLocation): StockLocationDomain` and `toEntity(domain: StockLocationDomain): DeepPartial<StockLocation>`. The mapper is the boundary between the persistence shape (mutable, full TypeORM annotations, JS Date) and the domain shape (private setters, invariant-enforced constructor). Use the existing `stock-item.mapper.ts` from before task-01 as a structural reference, but note that file is deleted by task-01 — the new mapper lives on disk first as the new template.

Two name-collision points to handle explicitly: the persistence entity is `class StockLocation` (decorated `@Entity`), and the domain class is also `class StockLocation`. The mapper file resolves this by importing them under distinct aliases — `StockLocationDomain` (from `../../domain`) and `StockLocationEntity` (from `./stock-location.entity`). This is the same pattern used for the `Product`/`ProductDomain` pair in the catalog microservice (epic-02 task-02). Document the aliasing convention in the doc deliverable so a future contributor doesn't try to rename one side.

## `apps/inventory-microservice/.../application/ports/stock-location.repository.port.ts`

```ts
import { StockLocation } from '../../domain';

export const STOCK_LOCATION_REPOSITORY = Symbol('STOCK_LOCATION_REPOSITORY');

export interface IStockLocationListPayload {
  activeOnly?: boolean;
  correlationId?: string;
}

export interface IStockLocationRepositoryPort {
  findById(id: string): Promise<StockLocation | null>;
  findByCode(code: string): Promise<StockLocation | null>;
  list(payload: IStockLocationListPayload): Promise<StockLocation[]>;
  save(location: StockLocation): Promise<StockLocation>;
}
```

No `delete(id)` — the soft-delete rule is enforced at the port level: there is no API for hard deletion. A future contributor who wants to "remove a location" has to call `save(location.deactivate())`; the port shape makes that the only path.

## `StockTypeormRepository` extension

The existing throwing-stub class (post task-01) grows four new method implementations — the four members of `IStockLocationRepositoryPort`. The class declaration changes from `implements IStockRepositoryPort` to `implements IStockRepositoryPort, IStockLocationRepositoryPort`. The constructor regains a `@InjectRepository(StockLocationEntity)` argument and a `Repository<StockLocationEntity>` field. The throwing-stub methods for `findById`/`findBySku`/`save` on the `StockItem` side stay throwing — task-03 reshapes them around `StockLevel`.

Alternative considered: split into `StockLocationTypeormRepository` as a separate class. **Rejected** because (a) the EntityManager binding is per-app, not per-entity, and routing both through one class avoids two transaction-scope passes, (b) the DI module then needs only one new binding rather than two, (c) `BaseTypeormRepository<>` is single-typed and not worth re-introducing as a generic mixin for two entities — both repositories are small enough that the extra abstraction would lose. Document this in the doc deliverable so the trade-off is explicit.

## Migration: `migrations/<timestamp>-CreateStockLocationTableAndSeedDefault.ts`

`up()`:

1. `CREATE TABLE stock_location` with the column shape from the entity above.
2. `CREATE UNIQUE INDEX uq_stock_location_code ON stock_location (code)`.
3. `INSERT INTO stock_location (id, name, code, type, address, gln, active) VALUES ('default-warehouse', 'Default Warehouse', 'DEFAULT-WAREHOUSE', 'warehouse', NULL, NULL, TRUE) ON DUPLICATE KEY UPDATE id = id;` — the `ON DUPLICATE KEY UPDATE id = id` no-op makes the insert idempotent under re-run (MySQL syntax; if the project uses TypeORM's QueryRunner builder, use `qr.insert(StockLocation, [...]).orIgnore()` or the equivalent — verify which idiom is used in `1772600000000-InitStarterEntities.ts` and match it).

`down()` is a no-op (project policy — forward-only).

The default-warehouse row is the **only** row inserted by this migration. The seed in `scripts/test-db-seed.ts` (extended in task-10) does not insert additional locations; it only insures `stock_level` rows exist per seeded variant at the default warehouse.

## `stock.module.ts` update

```ts
imports: [
  DatabaseModule.forFeature([StockLocationEntity]),
  MicroserviceClientNotificationModule,
],
providers: [
  StockTypeormRepository,
  { provide: STOCK_REPOSITORY, useExisting: StockTypeormRepository },
  { provide: STOCK_LOCATION_REPOSITORY, useExisting: StockTypeormRepository },

  // … existing StockCache / StockRabbitmqPublisher / TypeormTransactionAdapter providers …

  // The three use-case providers from before task-01 (AddStockUseCase, GetStockUseCase,
  // ReserveStockForOrderUseCase) are still listed here — they fail at runtime against
  // the throwing-stub side of the repository, but type-check fine. Task-05 deletes
  // them and adds the new use cases.
]
```

## Files to add

- `apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts`
- `apps/inventory-microservice/src/modules/stock/domain/spec/stock-location.model.spec.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-location.entity.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-location.mapper.ts`
- `apps/inventory-microservice/src/modules/stock/application/ports/stock-location.repository.port.ts`
- `migrations/<timestamp>-CreateStockLocationTableAndSeedDefault.ts`
- `docs/implementation/04-inventory-stock-level-and-location/02-default-stocklocation-auto-provision.md`

## Files to modify

- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/stock-typeorm.repository.ts` — add the four `StockLocation` methods; the `StockItem`-side throwing stubs stay.
- `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/index.ts` — re-export the new entity + mapper.
- `apps/inventory-microservice/src/modules/stock/application/ports/index.ts` — re-export `STOCK_LOCATION_REPOSITORY` + `IStockLocationRepositoryPort`.
- `apps/inventory-microservice/src/modules/stock/domain/index.ts` — re-export `StockLocation` (the domain class — collides with the entity name, hence the aliasing convention).
- `apps/inventory-microservice/src/modules/stock/infrastructure/stock.module.ts` — `DatabaseModule.forFeature([StockLocation])` + the new provider binding.

## Files to delete

None.

## Tests

- New spec `stock-location.model.spec.ts` is the only test added. It exercises 12+ invariants pure-domain.
- The existing `stock-item.model.spec.ts` continues to pass; `StockItem` is still the domain class until task-04.
- `yarn migration:run` against a fresh DB produces a `stock_location` table with exactly one row.
- `mysql -e "SELECT * FROM stock_location"` returns the seeded row.
- Re-running the migration (after a manual `INSERT IGNORE` of a duplicate id) does not error.

## Doc deliverable

Write `docs/implementation/04-inventory-stock-level-and-location/02-default-stocklocation-auto-provision.md`. Target ~140 lines. Sections:

1. **Open Question Q8 restated.** Why exactly one default location is auto-provisioned at install. The epic's rationale: making the default optional creates a migration hazard the moment a second warehouse appears (cite Vendure's pattern).
2. **The seeded row.** Concrete values (`id`, `code`, `type`, `address`, `gln`, `active`). Why the `id` is a deterministic string (`default-warehouse`) rather than a UUID — so test fixtures, the API gateway's "omit `stockLocationId` ⇒ default" rule, and the human-debuggable JSON payloads all share one stable identifier.
3. **Idempotent INSERT pattern.** The `ON DUPLICATE KEY UPDATE id = id` MySQL idiom (or the QueryRunner-builder equivalent — match the project's existing migration style). Why the seed is in the migration rather than in `scripts/seeds/`: production deploys do not run the seed script; the migration is the only "ran on every environment exactly once" code path.
4. **Aggregate boundaries.** Why `StockLocation` has no `version` column (low write rate, admin-only), why `address` is JSON rather than a structured table (the postal-schema scope creep is out of universal-core), why `gln` is exactly 13 digits (GS1 standard).
5. **The soft-delete-via-`active=false` rule.** Cite the epic's "Architectural Decisions Honored" line. The port surface has no `delete(id)` method — the only path to "remove" a location is `save(location.deactivate())`. A future `Re-balance Stock` operation (epic-07's `Transfer Stock`, epic-15's multi-location routing) will need to handle the "location was deactivated, what happens to its `stock_level` rows" question; this doc forward-references that without solving it.
6. **The single-class repository decision.** Why `StockTypeormRepository` carries both the `IStockRepositoryPort` and the `IStockLocationRepositoryPort` surfaces (single EntityManager binding, less DI plumbing, both repositories are small). When the trade-off would flip: if `StockLocation` ever grows event-emission (e.g. a `LocationActivated` event with downstream consumers), splitting becomes worth the cost.
7. **Adding a second location later.** Concrete sketch: a future admin endpoint `POST /api/inventory/locations` calls a `RegisterStockLocation` use case that delegates to `IStockLocationRepositoryPort.save(new StockLocation(...))`. The default-warehouse row is untouched. No migration is needed. The auto-init consumer of `catalog.variant.created` (task-07) continues to target `default-warehouse` only — the policy "new variants land at the default" is hard-coded in the consumer; a future "policy-driven default" is out of universal core.
8. **Forward links.** Task-03 adds `stock_level` whose `stock_location_id` FK references the row created here. Task-07 binds the consumer that creates `StockLevel` rows at this default location. Task-09 surfaces the location list via the api-gateway.

## Carryover produced (consumed by task-03 onward)

- `stock_location` table exists with the seeded `default-warehouse` row.
- `StockLocation` domain class is on disk under `domain/stock-location.model.ts`.
- `StockLocationEntity` + mapper exist.
- `IStockLocationRepositoryPort` is implemented by `StockTypeormRepository`; DI is wired.
- The throwing-stub on the `StockItem` side of `StockTypeormRepository` is still in place (tasks 03 + 05 dismantle it).
- Doc `02-default-stocklocation-auto-provision.md` exists.

## Exit criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; the new `stock-location.model.spec.ts` is green with at least 12 cases.
- [ ] `yarn build:inventory-microservice` succeeds.
- [ ] `yarn migration:run` against a fresh DB creates the `stock_location` table with the unique `code` index and inserts the seeded `default-warehouse` row.
- [ ] Re-running the migration after manual mutation does not error (idempotency).
- [ ] `mysql -e "SELECT id, code, type, active FROM stock_location"` returns exactly `default-warehouse | DEFAULT-WAREHOUSE | warehouse | 1`.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `02-default-stocklocation-auto-provision.md` exists with the eight sections above filled.
