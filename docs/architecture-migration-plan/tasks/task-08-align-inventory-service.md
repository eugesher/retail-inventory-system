# task-08 — Align Inventory service to hexagonal layout (Phase 5)

## Context

- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-07.md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: notification service is the canonical
  per-module template. This task reshapes the inventory service in the
  same shape. Inventory has the clearest aggregate (Stock /
  StockItem) and is smaller than retail — the right next step before
  tackling retail/orders. The existing layout
  (`apps/inventory-microservice/src/app/api/product-stock/providers/<feature>-<action>.service.ts`
  plus a `common/modules/product-stock-common/` shared façade per
  ADR-002) is structurally close to use cases; the work is mostly
  relocation plus introducing ports/adapters and a domain model that
  doesn't double as the TypeORM entity. **Cache-aside semantics from
  ADR-002 must be preserved** — only the file layout and the shape
  of the abstractions change.

## Prerequisites

- [ ] `_carryover-07.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] `@retail-inventory-system/contracts/inventory/` exposes the
  events this service will publish (`stock.reserved`, `stock.low`).
  Review and add any missing event contracts before starting.

## Goal

Reshape `apps/inventory-microservice/src/` from its current
`app/api/product-stock/providers/*-<action>.service.ts` layout into
per-module `{application,domain,infrastructure,presentation}`
directories under `modules/stock/`. The existing
`product-stock-common` façade and its sub-providers (`-add`, `-get`,
`-cache`) move into `modules/stock/infrastructure/` and become the
adapters behind a `StockRepositoryPort` + `CachePort`. Pino
correlation and ADR-002 cache-aside contract continue to hold.

## Steps

1. **Inventory the service.** Per `apps/inventory-microservice/src/`,
   the current file set is:
   - `app/api/product-stock/product-stock.controller.ts` (handlers
     for `INVENTORY_PRODUCT_STOCK_GET` and
     `INVENTORY_ORDER_CONFIRM`).
   - `app/api/product-stock/providers/{product-stock-get,product-stock-order-confirm}.service.ts`
     plus six unit specs under `providers/spec/` and the cousin
     specs under `common/modules/product-stock-common/.../spec/`.
   - `app/common/entities/{product,product-stock,product-stock-action,storage}.entity.ts`.
   - `app/common/modules/product-stock-common/`:
     `product-stock-common.module.ts`, `.service.ts` (façade),
     `interfaces/{product-stock-common-add,-cache,-get}.interface.ts`,
     and `providers/{-add,-cache,-get}.service.ts`.
   This module is the only feature in inventory today. Rename the
   target module to `stock` (singular aggregate name), not
   `product-stock` (which is a join name).

2. **Create the module skeleton** at
   `apps/inventory-microservice/src/modules/stock/{application/{use-cases,ports,dto},domain/{events},infrastructure/{persistence,messaging,cache},presentation/dto}/`.

3. **Domain.**
   - `domain/stock-item.model.ts` — pure class. Constructor enforces
     invariants (`quantity >= 0`,
     `reservedQuantity <= quantity`).
   - `domain/storage.model.ts` — value object wrapping the storage
     identifier; preserves the existing
     `INVENTORY_DEFAULT_STORAGE` semantics from
     `@retail-inventory-system/contracts/inventory/inventory.constants.ts`.
   - `domain/events/stock-reserved.event.ts`,
     `stock-released.event.ts`,
     `stock-low.event.ts` — extend `DomainEventBase` from
     `@retail-inventory-system/ddd`. (`stock-low` is the trigger
     for the notification path — emit when remaining quantity
     drops below a configurable threshold; threshold lives in
     `libs/contracts/inventory/inventory.constants.ts`.)

4. **Application.**
   - `application/ports/stock.repository.port.ts` — interface
     `StockRepositoryPort` with `findById`, `findBySku`,
     `aggregateForProduct(productId, storageIds?)`, `appendDeltas(...)`,
     `save`, plus DI symbol `STOCK_REPOSITORY`.
   - `application/ports/stock-events.publisher.port.ts` — interface
     for emitting domain events to RabbitMQ.
   - `application/ports/stock-cache.port.ts` — wraps the
     `CachePort` from `@retail-inventory-system/cache` with
     stock-specific key building (relocated from
     `CacheHelper.keys.productStock`).
   - `application/use-cases/`:
     - `get-stock.use-case.ts` (was `ProductStockGetService`).
     - `reserve-stock-for-order.use-case.ts` (was
       `ProductStockOrderConfirmService`). Preserves the
       transactional contract from ADR-002: invalidate cache
       **after** commit, fire-and-forget.
     - `add-stock.use-case.ts` (was the
       `product-stock-common-add` façade path) — kept as
       internal-only today.
   - `application/dto/`: command + query + view DTOs per the
     naming convention (`product-stock-get.query.ts`,
     `product-stock.view.ts`, etc.).

5. **Infrastructure.**
   - `infrastructure/persistence/`:
     - `product.entity.ts`, `product-stock.entity.ts`,
       `product-stock-action.entity.ts`, `storage.entity.ts` —
       relocated from `app/common/entities/`.
     - `stock-item.mapper.ts` — entity ↔ domain.
     - `stock-typeorm.repository.ts` — implements
       `StockRepositoryPort`. Extends `BaseTypeormRepository` from
       `@retail-inventory-system/database`. The existing
       `product-stock-common-get.service.ts` SQL aggregation
       (`SUM(quantity) ... GROUP BY storageId`) folds into this
       repository's `aggregateForProduct(...)` method.
   - `infrastructure/cache/stock-redis.cache.ts` — implements
     `StockCachePort` on top of the `CachePort` from
     `@retail-inventory-system/cache`. The existing
     `product-stock-common-cache.service.ts` (key building, SCAN +
     UNLINK invalidation, graceful-degradation try/catch) ports
     directly into this adapter. **Audit references continue to
     hold**: leave the `AUDIT-2026-05-08 [CACHE-…]` annotations
     in place; task-11 generalizes cache and may resolve them.
   - `infrastructure/messaging/stock-rabbitmq.publisher.ts` —
     implements `StockEventsPublisherPort`; uses routing keys from
     `@retail-inventory-system/messaging`.
   - `infrastructure/stock.module.ts` binds port symbols to
     adapters, imports `DatabaseModule.forFeature([...])`,
     `MessagingModule`, `CacheModule`, `LoggerModule`.

6. **Presentation.**
   - `presentation/stock.controller.ts` —
     `@MessagePattern(ROUTING_KEYS.INVENTORY_PRODUCT_STOCK_GET)`,
     `@MessagePattern(ROUTING_KEYS.INVENTORY_ORDER_CONFIRM)`. Use
     cases are DI-injected. The `IProductStockOrderConfirmPayload`
     shape stays the same — only the location moves.

7. **Update `app.module.ts`** to import `StockModule` (the
   relocated module) and drop references to the old
   `app/api/product-stock/` and `app/common/modules/product-stock-common/`
   paths.

8. **Update `main.ts`** so the first import is
   `@retail-inventory-system/observability/tracer`.

9. **TypeORM migrations** stay where they are (under top-level
   `migrations/`). The `stock` module does not own migration
   files.

10. **Tests.**
    - Migrate the existing six product-stock specs alongside their
      service files. Spec paths follow the new module layout
      (`modules/stock/.../spec/<file>.spec.ts`). Test bodies
      change only where the imported names changed — the assertions
      and mocks should otherwise be identical.
    - Add unit tests against in-memory `StockRepositoryPort` for
      invariant enforcement (e.g., reserving more than available
      throws).
    - Integration test against testcontainers MySQL for
      `StockTypeormRepository` is **deferred** unless the
      `test:infra:up` setup already supports container injection
      from a unit suite. The existing E2E
      (`test/system-api.e2e-spec.ts`) covers the integration
      surface; if a contract drift would slip past the E2E,
      promote one targeted integration test here.

11. **Delete the old `app/api/product-stock/` and
    `app/common/modules/product-stock-common/` folders** once
    every consumer is repointed and the build is green.

## Documentation updates required

- [ ] `README.md`: ensure the "Architecture" section now describes
  the standard per-module hexagonal layout consistently for the
  notification and inventory services. No special-casing.
- [ ] `CLAUDE.md`: remove the obsolete "Service Structure" block
  describing `app/api/<feature>/providers/`. Replace with a
  pointer to the canonical per-module template (notification
  module from task-07).
- [ ] `docs/adr/NNN-stock-aggregate-and-port-adapter.md`: new ADR
  documenting the Stock aggregate boundaries and the
  port-and-adapter split. Cross-references ADR-002 for the
  preserved cache-aside contract.

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps.
- [ ] `yarn lint` succeeds.
- [ ] `yarn test:unit` succeeds — including the migrated
  product-stock specs (6) and any newly added.
- [ ] `yarn test:e2e` succeeds for the inventory-touching paths
  in `system-api.e2e-spec.ts`.
- [ ] `grep -r '@Entity' apps/inventory-microservice/src` returns
  only files under `modules/stock/infrastructure/persistence/`.
- [ ] No file under `apps/inventory-microservice/src/` injects
  `Repository<...>` from `typeorm` directly into a service or
  controller — only the typeorm-repository adapter does.

## Carryover

Write `_carryover-08.md` with:
- File-rename map for the inventory service.
- Use-case map (old `*.service.ts` → new `*.use-case.ts`).
- Tests migrated (paths) and tests added (paths).
- Anything deferred to task-11 (cache generalization) or
  task-10 (OTel) — particularly any cache-trace span work
  intentionally postponed.
- Whether the `audit-2026-05-08 [CACHE-…]` annotations were
  preserved verbatim or had their line references updated.
- Verification results.
- Suggested adjustments to task-09 (retail/orders) — the same
  template applies; record any complications encountered here.
