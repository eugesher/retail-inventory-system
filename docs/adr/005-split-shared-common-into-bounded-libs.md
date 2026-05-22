# ADR-005: Split shared `libs/common` into bounded libraries

- **Date**: 2026-05-09
- **Status**: Accepted

---

## Context

At task-03 entry the repository had four libraries under `libs/`:
`common`, `config`, `inventory`, `retail`. Of these, `libs/common`
had grown into a grab-bag — it carried microservice-routing enums
(`MicroserviceMessagePatternEnum`, `MicroserviceQueueEnum`,
`MicroserviceClientTokenEnum`, `AppNameEnum`), a Redis cache helper
(`CacheHelper`), correlation-ID middleware/decorator/types, RabbitMQ
client modules (`MicroserviceClientInventoryModule`,
`MicroserviceClientRetailModule`), and the cross-service interface
`IOrderProductConfirm` (duplicated under `libs/retail/interfaces/`).

The fat-`common` arrangement was a problem for ADR-004's hexagonal
target in three concrete ways:

- The cross-service message contracts (enums + interfaces) were
  intermingled with framework infrastructure (Nest middleware,
  `@nestjs/microservices` modules), so any module that needed a
  routing enum pulled in the entire transport-aware tree
  transitively.
- TypeORM glue lived in `libs/config/typeorm-module.config.ts`, which
  meant the `app.module.ts` of each service constructed
  `new TypeormModuleConfig(entities)` directly. There was no place
  to put a shared base entity, a shared mapper-aware repository, or
  a single source of truth for `SnakeNamingStrategy`.
- The `architecture-lint` enforcement queued for task-12 (per ADR-004)
  needs distinct lib element-types to write boundary rules against.
  A single `lib-common` element collapses the rule space; splitting
  into purpose-named libs (`contracts`, `database`, `messaging`,
  `cache`, `observability`, `ddd`) gives each its own type.

This ADR records the decision to split `common` and the surrounding
libs into purpose-named bounded libraries, and the structural choices
we made within that split (folder layout, ID strategy on `BaseEntity`,
shim policy for the migration window).

The split is sequenced: task-03 (this task) lands the **foundation**
libs that the rest of the migration depends on (`contracts`,
`database`, slimmed `common`). Task-04 lands the **integration**
libs (`messaging`, `cache`, `observability`, `ddd`). Task-06 builds
`auth` from scratch.

---

## Decision

### New libraries (this task)

- **`@retail-inventory-system/contracts`** — cross-service message
  and DTO contracts. Plain TypeScript only (`class-validator` and
  `@nestjs/swagger` decorators on DTOs are allowed because they are
  the contract; no Nest dependency-injection decorators). Sub-areas:
  - `microservices/` — `AppNameEnum`, `MicroserviceClientTokenEnum`,
    `MicroserviceMessagePatternEnum`, `MicroserviceQueueEnum`. Cross-
    service routing primitives that aren't owned by any one bounded
    context.
  - `retail/` — Order DTOs, enums, interfaces (relocated from
    `libs/retail/`), plus the canonical home of `IOrderProductConfirm`.
  - `inventory/` — Product-stock DTOs, payload types, and constants
    (relocated from `libs/inventory/`).

- **`@retail-inventory-system/database`** — TypeORM base. Exports
  `BaseEntity`, `BaseTypeormRepository<TEntity, TDomain>`,
  `SnakeNamingStrategy` (re-export of `typeorm-naming-strategies`),
  and `DatabaseModule.forRoot(entities)` /
  `DatabaseModule.forFeature(entities)`. App modules call
  `DatabaseModule.forRoot(entities)` instead of constructing
  `TypeormModuleConfig` directly.

### Slimmed `@retail-inventory-system/common`

Reduced to framework-free utility scaffolds:

- `result.ts` — `Result<T, E>` discriminated union plus `ok` / `err`
  helpers.
- `exceptions/domain.exception.ts` — abstract `DomainException` (no
  Nest `HttpException` dependency).
- `pagination/page.types.ts` — `IPageRequest`, `IPage<T>`.
- `types/utility.types.ts` — `Maybe<T>`, `Nullable<T>`.

For one release the lib also still hosts `cache/`, `correlation/`,
and `modules/` (the `MicroserviceClient*Module` modules). These move
to `libs/cache`, `libs/observability`, and `libs/messaging` in
task-04 respectively. The old `libs/common/index.ts` re-exports the
moved-to-contracts symbols so existing import paths keep compiling
during the migration window; those re-exports are removed in task-14.

### `BaseEntity` ID strategy

`BaseEntity` uses an auto-increment integer `id`
(`@PrimaryGeneratedColumn()`). Trade-offs considered:

- The five entities that exist today (`order`, `order_product`,
  `order_status`, `order_product_status`, `product`, `product_stock`,
  `storage`, `customer`) all already use auto-increment integer
  primary keys, so adopting UUIDs would force a one-time data
  migration and break all currently-issued IDs.
- Auto-increment has the well-known downsides — sequential IDs leak
  cardinality, are predictable for adversaries, and are awkward to
  generate client-side before insert. None of these are
  load-bearing today: there is no public ID surface (the gateway
  hasn't been authenticated yet — task-06), no sharding, and no
  pre-insert ID flow.
- Switching to UUID v7 (time-ordered) is the future-friendly choice
  if the project takes on a multi-tenant or sharded shape. That is
  a future ADR once such a need materializes.

`BaseEntity` also includes `createdAt`, `updatedAt`, and a nullable
`deletedAt` to support TypeORM's soft-delete (`@DeleteDateColumn`).
Existing entities are not retrofitted to extend `BaseEntity` in this
task; that conversion is part of task-08 (inventory align) and
task-09 (retail align).

### Shim policy for the migration window

Three classes of shim are introduced and all are removed in task-14:

1. **`libs/common/index.ts`** re-exports the moved-to-contracts
   symbols (`AppNameEnum`, `MicroserviceClientTokenEnum`,
   `MicroserviceMessagePatternEnum`, `MicroserviceQueueEnum`,
   `IOrderProductConfirm`).
2. **`libs/inventory/index.ts`** and **`libs/retail/index.ts`** are
   reduced to a single `export * from '@retail-inventory-system/contracts'`
   line. The TS-path aliases for these libs remain in `tsconfig.json`
   for one release.
3. **`libs/config/typeorm-module.config.ts`** keeps the
   `TypeormModuleConfig` class unchanged (option B in task-03 step 7
   — "kept as a shim"). The factory logic is now owned by
   `DatabaseModule.forRoot()`; the class is functionally equivalent
   and stays only to avoid forcing a one-task migration of every
   downstream consumer at the same moment as the structural move.

Apps' import sites are repointed to the new paths in this task; the
shims are defence-in-depth for any consumer (or future task) that
hasn't been repointed yet.

### Layout choice

`libs/contracts` and `libs/database` are flat directories with
`index.ts` at the root, mirroring the existing
`libs/{common,config,inventory,retail}` shape. They do **not** have a
`src/` subfolder, a per-lib `tsconfig.lib.json`, or an entry under
`nest-cli.json` `projects`. The four existing libs follow this same
flat shape at commit `04713bb` (the migration-start state);
making the new libs match keeps all six libs uniform.

---

## Alternatives Considered

**Keep all enums and interfaces under `libs/common`.** Rejected. The
microservice-routing enums and the `IOrderProductConfirm` interface
are cross-service contracts; placing them in the same lib that holds
the Nest middleware and RabbitMQ-client modules makes any consumer
of the contract pull in transport-aware framework code. The whole
point of `libs/contracts` is that a domain-layer file in
`apps/<service>/src/modules/<module>/domain/` can import a contract
without taking on a Nest dependency. ADR-004's hexagonal target
forbids that coupling at lint time (task-12), so the split has to
land before the lint rules go on.

**Promote each lib to a real Yarn workspace** (with its own
`package.json`). Rejected. The four existing libs are TS-path aliases
only — no `package.json`, no entry in `yarn workspaces list`. Adding
real workspaces for the new libs would introduce a hybrid state
(some libs are workspaces, some aren't), which task-12 would have to
work around. Promoting all six libs to workspaces is plausible but
out of scope for this task; left for a future ADR if the build graph
demands it.

**Keep `TypeormModuleConfig` as the supported API and skip
`DatabaseModule`.** Rejected. The factory class works for the wiring
it does today, but it cannot host `BaseEntity`, the shared base
repository, or the `forFeature` split that future per-module
hexagonal layouts will use (each module will register its own
entities via `DatabaseModule.forFeature` rather than aggregating in
`app.module.ts`). Once that capability is needed, a `DatabaseModule`
emerges anyway; building it in this task gives task-08 and task-09
something to consume.

**Move `correlation/`, `cache/`, and the `MicroserviceClient*Module`
modules to their final homes in this task.** Rejected as scope
creep. These three concerns are non-trivial — `correlation/` will
gain trace-id enrichment for OTel (task-10), `cache/` will gain a
port/adapter shape and the schema-version segment from the
`AUDIT-2026-05-08` items, and the messaging modules will gain dotted
routing-key constants. Doing all of that in task-03 would entangle
the foundation move with the integration move. Task-04 owns those
moves; this task only stages them.

---

## Consequences

### Positive

- The hexagonal target (ADR-004) gains a clean shared-contracts seam:
  domain layers in any module can import a contract without taking
  on Nest framework dependencies.
- Architecture-lint (task-12) gets distinct lib element-types
  (`lib-contracts`, `lib-database`, `lib-common`, `lib-config`) to
  write boundary rules against, without a fat-`common` collapse.
- `BaseEntity` and `BaseTypeormRepository` give the per-service
  align tasks (task-08 inventory, task-09 retail) a single place to
  attach soft-delete, mapper hooks, and (later) audit columns.
- `DatabaseModule.forRoot()` removes the `TypeormModuleConfig`
  construction from each `app.module.ts`, simplifying app wiring and
  centralizing the `SnakeNamingStrategy` decision.

### Negative / Trade-offs

- A migration window with shims in three places (`libs/common`,
  `libs/inventory`, `libs/retail`, plus the `TypeormModuleConfig`
  shim in `libs/config`) is in-flight code that has to be kept until
  task-14. The shim re-exports are clearly comment-marked so a future
  reader can tell at a glance what is migration scaffolding versus
  production API.
- Choosing auto-increment IDs for `BaseEntity` rather than UUID v7
  preserves the current shape but locks the project into integer
  PKs unless we revisit. The trade-off is documented above; if a
  future ADR adopts UUIDs, `BaseEntity` is the right place to flip
  the strategy.
- The flat lib layout (no `src/`, no `tsconfig.lib.json`) means the
  new libs are not registered in `nest-cli.json` `projects`. They
  resolve fine via `tsconfig.json` paths, but Nest schematics aware
  of `nest-cli.json` will not see them. If a future task standardizes
  on the proper Nest-library shape, the migration is a single
  task that touches all six libs at once.

---

## References

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) — the
  hexagonal target this split enables.
- [ADR-018](018-nestjs-monorepo-apps-and-libs.md) — the NestJS monorepo
  shape that hosts every `libs/<name>` introduced here.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — the persistence
  stack the new `libs/database` lib codifies (`BaseEntity`,
  `BaseTypeormRepository`, `SnakeNamingStrategy`).
