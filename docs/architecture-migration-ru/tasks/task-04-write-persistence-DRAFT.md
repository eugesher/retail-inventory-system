# task-04 — Write persistence articles (Phase: persistence/) — DRAFT

> **DRAFT — may be revised by task-01.**

## Context

- Migration source of truth: `docs/architecture-migration-plan/`
  (ADR-019 for the persistence stack, ADR-005 for the
  `libs/database` split, ADR-012 / ADR-013 for the repository ports
  in each microservice, and `parts/recommendation.md` Section 3 +
  Section 4 for the entity-vs-domain rule).
- Previous carryover:
  `docs/architecture-migration-ru/tasks/_carryover-03.md`
  (READ FIRST).
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`.
- Conventions preamble: see `task-01-survey-and-scaffold.md`.
- Where the guide stands: concepts and project shape are written. The
  reader knows hexagonal + DDD + the four-service monorepo. This task
  is the first deep-dive into one concern (persistence).

## Prerequisites

- [ ] `_carryover-03.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] HEAD SHA is recorded in `_carryover-01.md`.

## Goal

Walk the reader through the persistence stack: TypeORM + MySQL, the
entity-vs-domain split, the mapper/repository pair, the
`BaseEntity` / `BaseTypeormRepository` base classes from
`libs/database`, and the `SnakeNamingStrategy`. After this group, a
mid-level reader should be able to add a new aggregate to one of the
microservices without breaking the layering rules.

## Article slots to fill

- [ ] `docs/architecture-migration-ru/persistence/typeorm-overview.md`
- [ ] `docs/architecture-migration-ru/persistence/entity-vs-domain-model.md`
- [ ] `docs/architecture-migration-ru/persistence/mappers-and-repositories.md`
- [ ] `docs/architecture-migration-ru/persistence/base-entity-and-base-repository.md`
- [ ] `docs/architecture-migration-ru/persistence/snake-naming-strategy.md`

> Approximate guidance per article:
>
> - **typeorm-overview** — ~2000 words. Why TypeORM + MySQL
>   specifically (ADR-019), `DataSource` + migrations workflow, the
>   `yarn migration:run` / `:revert` / `:create` / `:show` scripts,
>   `synchronize: false` rule, where the migration files live.
> - **entity-vs-domain-model** — ~1800 words. The
>   "`@Entity()` decorators belong in `infrastructure/persistence/`
>   only" rule. Side-by-side example: the
>   `apps/inventory-microservice/.../domain/stock-item.model.ts`
>   pure aggregate vs the `infrastructure/persistence/product-stock.entity.ts`
>   (verify path) TypeORM entity.
> - **mappers-and-repositories** — ~1800 words. The mapper
>   class as the entity ↔ domain boundary. Repository port
>   (`IOrderRepositoryPort`) vs adapter (`OrderTypeormRepository`).
>   Show how the use case depends on the port and the module wires
>   the adapter via Nest DI.
> - **base-entity-and-base-repository** — ~1200 words. Anchor to
>   `libs/database/base.entity.ts` and
>   `libs/database/base-typeorm.repository.ts`. The auto-increment
>   integer PK choice (ADR-005 §3), soft-delete via `deletedAt`,
>   `DatabaseModule.forRoot` / `forFeature` wiring.
> - **snake-naming-strategy** — ~800 words. The simplest in the
>   group. Why camelCase in TypeScript / snake_case in MySQL, the
>   `typeorm-naming-strategies` re-export from `libs/database`.

## Steps

1. **Read previous carryover.**
2. **Read the source ADRs.** ADR-019 (full), ADR-005 §3
   (`BaseEntity` decision), ADR-012 §3 + ADR-013 §3 (the actual
   repository ports), ADR-017 §6 (the documented `EntityManager`
   leak in `IStockRepositoryPort` — this is worth a callout in
   `mappers-and-repositories`).
3. **Author each article.** Suggested anchors (verify paths in
   task-01):
   - **typeorm-overview**: `migrations/config/data-source.ts`,
     `package.json` scripts block (migration:*), one of the
     migration files under `migrations/*.ts`.
   - **entity-vs-domain-model**: side-by-side excerpts from
     `apps/inventory-microservice/src/modules/stock/domain/stock-item.model.ts`
     and the matching TypeORM entity.
   - **mappers-and-repositories**:
     `apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts`,
     `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-typeorm.repository.ts`,
     and the `order.mapper.ts` (verify exact name).
   - **base-entity-and-base-repository**:
     `libs/database/base.entity.ts`,
     `libs/database/base-typeorm.repository.ts`,
     `libs/database/database.module.ts`.
   - **snake-naming-strategy**: `libs/database/snake-naming.strategy.ts`,
     and an example `@Column` showing a camelCase field that becomes
     `snake_case` in MySQL.
4. **Document the open exception.** `entity-vs-domain-model` or
   `mappers-and-repositories` calls out `ARCH-LINT-EX-01`
   (the leaked `EntityManager` typing on `IStockRepositoryPort` —
   see ADR-017 §6). This is a one-paragraph aside; the reader sees
   that the architecture is honest about its compromises rather
   than papering over them.
5. **Cross-link** to `[[hexagonal-architecture]]`,
   `[[clean-architecture-layers]]`, `[[shared-libs-philosophy]]`,
   and forward to `[[mappers-and-repositories]]` from the entity
   article.

## Verification

- [ ] Five articles filled, no `заглушка` callouts.
- [ ] Permalinks against the recorded SHA on every excerpt.
- [ ] Every wiki link resolves.
- [ ] No orphans.

## Carryover

Write `_carryover-04.md` per the standard structure (articles
written, glossary, cross-refs, verification, suggestions).
