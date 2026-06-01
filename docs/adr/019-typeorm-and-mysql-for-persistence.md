# ADR-019: TypeORM + MySQL as the persistence stack

- **Date**: 2026-05-14
- **Status**: Accepted (amended 2026-05-27 — see §"Amendment (2026-05-27)" for the module-wiring rule re-scope)

---

## Context

The retail-inventory-system persists three independent slices of state:
the orders aggregate owned by the retail microservice
(`order`, `order_product`, `customer`, the `order_status` /
`order_product_status` reference tables), the stock aggregate owned by
the inventory microservice (`product`, `product_stock`, `storage`), and
the user/auth state owned by the gateway's `auth` module (`user`). Every
service connects to MySQL via a single `DATABASE_URL` env var and a
TypeORM `DataSource`. Migrations live in `migrations/` and are managed
through TypeORM's CLI (`yarn migration:run` / `:revert` / `:create` /
`:show`).

The TypeORM + MySQL pairing predates the migration. It is implicit in
every persistence ADR so far — [ADR-002](002-redis-cache-aside-product-stock.md)
caches a TypeORM `SUM/GROUP BY` aggregation,
[ADR-005](005-split-shared-common-into-bounded-libs.md) introduces a
`libs/database` lib with `BaseEntity` / `BaseTypeormRepository` /
`SnakeNamingStrategy`, [ADR-010](010-jwt-rbac-at-the-gateway.md) adds a
`user` table to the gateway via `DatabaseModule.forRoot([UserEntity])`,
and [ADR-012](012-stock-aggregate-and-port-adapter.md) /
[ADR-013](013-order-aggregate-and-cross-service-confirm.md) describe the
TypeORM-backed adapters that implement the inventory and retail
repository ports. None of them, however, record **why TypeORM and MySQL
specifically**, what alternatives were weighed, or what the trade-offs
are.

The decision matters because it constrains the migration workflow
(TypeORM CLI rather than Prisma's migrate, Sqitch, Atlas, etc.), the
test infrastructure (`yarn test:infra:up` provisions a MySQL container,
not Postgres), the naming convention (snake_case columns mapped to
camelCase TypeScript fields by `SnakeNamingStrategy`), and the
hexagonal-port surface (the previously-leaked `EntityManager` —
tracked as `ARCH-LINT-EX-01` in
[ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6 — has
since been wrapped behind an `ITransactionPort` so the application
layer no longer depends on TypeORM's unit-of-work shape).

---

## Decision

The persistence stack is **TypeORM with MySQL** for every service that
holds durable state.

**Object-relational mapper.** TypeORM, registered through
`@nestjs/typeorm` at the application boundary. Repository implementations
extend `BaseTypeormRepository<TEntity, TDomain>` from
`@retail-inventory-system/database` and own the entity ↔ domain mapping;
domain code (aggregates, value objects) is framework-free and
TypeORM-free per ADR-005's split.

**Database.** MySQL, accessed through `mysql2`. Connection string read
from the `DATABASE_URL` env var; Joi enforces presence at boot via the
config module schema in `libs/config`. The docker-compose file
provisions a single `mysql` container shared by all three persistence
slices today; production may split it later (one schema per service)
without an ADR change.

**Naming strategy.** `SnakeNamingStrategy` from
`typeorm-naming-strategies` (re-exported by
`@retail-inventory-system/database`). Every entity declares fields in
camelCase (`createdAt`, `productId`, `refreshTokenHash`); the naming
strategy maps them to `created_at`, `product_id`, `refresh_token_hash`
in MySQL. The convention is uniform across every entity.

**Base entity.** All durable entities extend `BaseEntity` from
`libs/database`. `BaseEntity` carries an auto-increment integer `id`
(`@PrimaryGeneratedColumn()`), `createdAt`, `updatedAt`, and a nullable
`deletedAt` for soft-delete (`@DeleteDateColumn`). The auto-increment
integer choice is recorded in ADR-005 §3 — UUID v7 is a future
possibility but not load-bearing today.

**Migrations.** Authored by hand into `migrations/<timestamp>-<slug>.ts`
and applied via the TypeORM CLI (`yarn migration:run`). Synchronization
(`synchronize: true`) is **off** in every environment, including local
dev. Migrations are the only path that mutates schema. Test seeds live
under `scripts/seeds/*.sql` and are applied by `yarn test:seed` after
migrations.

**Module wiring.** Apps consume the DB via `DatabaseModule.forRoot(entities)`
at the AppModule level and `DatabaseModule.forFeature(entities)` per
module. The factory inside `DatabaseModule.forRoot` is the single place
that constructs `TypeOrmModuleOptions` from `ConfigService` —
applications never import `@nestjs/typeorm` directly.

**Repository surface.** Per-aggregate ports
(`IStockRepositoryPort`, `IOrderRepositoryPort`,
`IUserRepositoryPort`) live in the application layer and are
TypeORM-free. Their implementations
(`StockTypeormRepository`, `OrderTypeormRepository`,
`UserTypeormRepository`) live in `infrastructure/persistence/` and are
the only files allowed to import `typeorm`, `@nestjs/typeorm`, or use
`InjectRepository`. The previously-tracked `ARCH-LINT-EX-01` exception
([ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6) — a
leaked `EntityManager` typing on the stock repository port — has since
been closed by the `ITransactionPort` abstraction: the port now accepts
an opaque `ITransactionScope`, and the TypeORM downcast lives only in
`TypeormTransactionAdapter` and `StockTypeormRepository`.

### Amendment (2026-05-27)

This amendment re-scopes the §"Module wiring" rule's binding intent —
*"applications never import `@nestjs/typeorm` directly"* — and the
§"Repository surface" rule's *"the only files allowed to import
`typeorm`, `@nestjs/typeorm`, or use `InjectRepository`"* — without
changing the decision they encode. The intent is preserved (keep
TypeORM types out of the application layer); the original phrasing was
over-broad about which layer counts as the boundary.

**Binding intent (clarified).** No `@nestjs/typeorm` or `typeorm` import
in `application/use-cases/`, `application/ports/`, `application/dto/`,
`presentation/`, `domain/`, `lib-contracts`, or `lib-ddd`. This matches
what the [ADR-017](017-architecture-lint-via-eslint-boundaries.md)
`boundaries/dependencies` per-source `disallow.dependency.module` lists
enforce today (`eslint.config.mjs`). The infrastructure layer —
including `infrastructure/<module>.module.ts` files that wire
feature-level entity registration — is intentionally **not** in scope.

**Module wiring (revised).** `DatabaseModule.forRoot(entities)` at the
AppModule level remains the single factory for `TypeOrmModuleOptions`
from `ConfigService` (unchanged). For per-module entity registration,
both forms are valid at the `infrastructure/<module>.module.ts` layer:

- `DatabaseModule.forFeature(entities)` — preferred when the call site
  has no shared-imports requirement. The wrapper is a one-line
  passthrough (`libs/database/database.module.ts:31-33`); the three
  microservice infrastructure modules use this form
  (`stock.module.ts`, `orders.module.ts`, the notification template).
- `TypeOrmModule.forFeature(entities)` — preferred when the call site
  needs to wire the resulting `DynamicModule` inline into a third-party
  callee's `imports: [...]`. The motivating case is
  `AuthLibModule.forRootAsync({ imports: [TypeOrmModule.forFeature([UserEntity])] })`
  in `apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts` —
  the working idiom since the ADR-010 landing.

**Repository surface (unchanged for the application layer).**
Per-aggregate ports remain TypeORM-free; the `ITransactionPort` +
opaque `ITransactionScope` seam (closing `ARCH-LINT-EX-01`) is the
binding mechanism that keeps the application layer ORM-agnostic.
Repository implementations under `infrastructure/persistence/` are
still the only place that uses `InjectRepository`, but `@nestjs/typeorm`
as an *import surface* is permitted across the wider `infrastructure/`
tree (the lint rules in `eslint.config.mjs` reflect this).

No code changes are required by this amendment; the `auth.module.ts`
precedent and any follow-on work that uses `TypeOrmModule.forFeature(...)`
at the infrastructure-module layer becomes compliant by the
clarification.

---

## Alternatives Considered

**Prisma.** Rejected for this project. Prisma's developer ergonomics
(typed query builder, opinionated migration tooling) are excellent for
straightforward CRUD workloads, but the migration's per-aggregate
hexagonal model leans on TypeORM-specific features that Prisma either
doesn't expose or exposes very differently:

- The append-only `product_stock` ledger uses `SELECT … FOR UPDATE` to
  serialize concurrent reserves; TypeORM's `EntityManager.transaction`
  + raw query support handles this directly, Prisma's `$queryRaw` works
  but disengages from the typed-client benefits Prisma's whole value
  proposition rests on.
- The cross-aggregate cache-aside in ADR-002 / ADR-016 needs the
  application use case to share an `EntityManager` with the
  transaction-scoped repository call; TypeORM's `EntityManager` is the
  unit-of-work primitive that pattern is shaped against.
- The migration prefers a thin mapping layer
  (`BaseTypeormRepository` + per-aggregate mappers) where the ORM
  exposes the SQL surface honestly. Prisma's client wraps the schema in
  a generated typed API; the abstraction is higher and harder to bend
  for low-level patterns.

Prisma would be a reasonable choice for a greenfield CRUD project. This
isn't one. Switching later remains possible (the repository ports are
ORM-agnostic by design), but the cost of the switch grows with the
schema, so this ADR pins TypeORM as the current commitment.

**MikroORM.** A close competitor to TypeORM with a stronger
unit-of-work model and a better explicit-flush story. Rejected because
the migration already invested in TypeORM through the existing entities,
the `BaseEntity` base class, and the migration tooling. The
incremental gain is real but not load-bearing for any decision the
migration is actually making, and the rip-and-replace cost would dwarf
the structural work the migration is shipping.

**ObjectionJS / Knex.** Rejected. ObjectionJS is a thin model layer over
Knex's query builder; it would let the codebase author SQL by hand and
keep type safety through declared schemas. The trade-off is more SQL
work per repository and a far smaller community than TypeORM. The
codebase doesn't have unusual query needs that justify the manual SQL
surface, and TypeORM's `QueryBuilder` covers the cases where the
declarative API isn't enough.

**Raw `mysql2` with hand-written mappers.** Rejected. The aggregate
shapes are small enough today that this would work, but the framework's
absence becomes a maintenance tax once joins, soft-delete, audit
columns, and migration tooling are layered in by hand. Every other ADR
in the catalogue assumes the ORM as the layer the repository port wraps.

**PostgreSQL instead of MySQL.** Considered. PostgreSQL has stronger
JSON support, richer indexing, and `LISTEN/NOTIFY` for some classes of
event work. None of those are load-bearing in the current schema: the
aggregates are normalised; JSON isn't used; cross-service notifications
go through RabbitMQ (ADR-020). MySQL was already provisioned by the
seed project and the migration's verification gates assume it. Future
work that needs Postgres-specific features (gen `tsvector` columns, GiST
indexes, JSONB query operators) is a credible ADR to revisit; today the
project doesn't have that need.

**SQLite for local development, MySQL in production.** Rejected.
Behavioural drift between the two — locking semantics, default
collation, `ON DELETE` cascade behaviour — would surface as test
divergence between dev and CI/prod. The docker-compose MySQL container
boots in seconds; the cost of using the same engine end-to-end is
trivial.

---

## Consequences

### Positive

- Mature, well-trodden stack: TypeORM and MySQL have an order of
  magnitude more community-tested patterns than any of the alternatives
  for the operations the project actually performs.
- `EntityManager.transaction(...)` is the unit-of-work primitive for
  the reserve-stock flow and the user-row + refresh-hash rotation in
  the auth module. No bespoke transaction wrapper required.
- Migrations are explicit, reviewable, and version-controlled. No
  auto-`synchronize` magic ever runs against a real database.
- `SnakeNamingStrategy` lets domain code stay camelCase without the
  schema drifting into camelCase too — keeps the SQL idiomatic.
- The shape of the repository ports (per-aggregate, mapper-aware) was
  shaped against TypeORM's API; ADR-012 and ADR-013 lean on the same
  conventions, which keeps the project surface uniform.

### Negative / Trade-offs

- TypeORM's release cadence and breaking-change history are notable.
  Major-version bumps demand careful migration of the entity decorators,
  query builder, and `EntityManager` calls. Mitigated by pinning the
  major version in `package.json`; revisited when a real upgrade need
  arises.
- The `EntityManager`-as-unit-of-work pattern is hidden behind the
  application-layer `ITransactionPort` (opaque `ITransactionScope`); the
  TypeORM downcast lives only in `TypeormTransactionAdapter` and
  `StockTypeormRepository`. The previously-documented `ARCH-LINT-EX-01`
  exception is closed.
- Auto-increment IDs (per ADR-005 §3) constrain the project away from
  client-generated identifiers and from sharding by primary key. Both
  are revisitable if a future ADR requires UUID v7.
- A single MySQL instance hosting three logical schemas today is a
  shared point of operational failure. The migration accepts this for
  the portfolio-project scale; splitting per-service databases is a
  future ADR if independent scale-out becomes necessary.

---

## References

- `libs/database/` — `BaseEntity`, `BaseTypeormRepository`, the
  `DatabaseModule.forRoot/forFeature` factory.
- `migrations/` — every schema change since the project bootstrap.
- [ADR-005](005-split-shared-common-into-bounded-libs.md) — the lib
  split that gave persistence its own `libs/database` home and chose
  the integer-PK strategy for `BaseEntity`.
- [ADR-002](002-redis-cache-aside-product-stock.md) — caches a TypeORM
  aggregation; the contract the cache adapters preserve.
- [ADR-012](012-stock-aggregate-and-port-adapter.md) — stock TypeORM
  repository whose `EntityManager` leak is now closed behind
  `ITransactionPort`.
- [ADR-013](013-order-aggregate-and-cross-service-confirm.md) — order
  TypeORM repository + the cross-aggregate transactional confirm flow.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) §6 — the
  previously-tracked `ARCH-LINT-EX-01` exception (rooted in this ADR's
  ORM choice) is now closed by the `ITransactionPort` abstraction.
