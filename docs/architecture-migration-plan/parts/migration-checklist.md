# Migration Checklist — Retail Inventory System → Hexagonal NestJS Monorepo

> Each item is concrete and reviewable as a single PR (or sub-PR). Tick boxes
> as work progresses. **Do not start any phase before the previous one is
> green in CI.**

## Phase 0 — Preparation (no code changes)

- [ ] Create branch `chore/architecture-migration` from `main`.
- [ ] Open a tracking issue per phase (Phase 1…Phase 6).
- [ ] Capture current `nest-cli.json`, `tsconfig.json`, `package.json`,
      `docker-compose.yml` to `docs/baseline/` for reference.
- [ ] Run full test suite and capture coverage baseline to
      `docs/baseline/coverage.txt`.
- [ ] Add `eslint-plugin-boundaries` (or `eslint-plugin-import` with
      `no-restricted-paths`) — but **don't enable rules yet**; only install.

## Phase 1 — Shared Library Restructuring (libs/)

- [ ] Generate `libs/contracts` via `nest g library contracts`.
- [ ] Generate `libs/messaging`, `libs/database`, `libs/cache`, `libs/auth`,
      `libs/observability`, `libs/ddd`.
- [ ] In `tsconfig.json`, add path aliases:
      `@app/contracts`, `@app/messaging`, `@app/database`, `@app/cache`,
      `@app/auth`, `@app/observability`, `@app/ddd`, `@app/common`.
- [ ] Move snake-naming TypeORM strategy into `libs/database/src/snake-naming.strategy.ts`.
- [ ] Move TypeORM `DataSource` factory into `libs/database/src/database.module.ts`.
- [ ] Add `BaseEntity` (`id`, `createdAt`, `updatedAt`, `deletedAt`) in
      `libs/database/src/base.entity.ts`.
- [ ] Add `BaseTypeormRepository<TEntity, TDomain>` with `find`, `save`,
      `softDelete` and a mapper hook.
- [ ] Move existing `RabbitMQ` client factory into
      `libs/messaging/src/rabbitmq.client.factory.ts`.
- [ ] Define `EXCHANGES` and `ROUTING_KEYS` constants in `libs/messaging`.
- [ ] Move JWT strategy + `RolesGuard` + `@CurrentUser()` decorator into
      `libs/auth/src/`.
- [ ] Move Pino logger config into `libs/observability/src/logger.module.ts`,
      including request-id and `traceId/spanId` redaction.
- [ ] Add `libs/observability/src/tracer.ts` with the OTel `NodeSDK` boot
      (auto-instrumentation for HTTP, MySQL, Redis, AMQP).
- [ ] Add `libs/cache/src/cache.port.ts` (`get`, `set`, `del`, `wrap`).
- [ ] Add `libs/cache/src/redis-cache.adapter.ts` implementing `CachePort`.
- [ ] Add `libs/cache/src/decorators/cacheable.decorator.ts`.
- [ ] Add `libs/ddd/src/{aggregate-root,entity,value-object,domain-event,repository.port}.base.ts`.
- [ ] Move existing shared DTOs from old `libs/common` into
      `libs/contracts/src/<service>/`.
- [ ] Delete the old `libs/common` (or keep a stub that re-exports for one
      release to ease migration).
- [ ] Update every `@app/common` import across `apps/*` to its new specific
      lib.
- [ ] Confirm `pnpm build` passes for all four apps.
- [ ] CI green.

## Phase 2 — API Gateway Layer Alignment

- [ ] In `apps/api-gateway/src/`, create `modules/` directory.
- [ ] Move existing `auth/` to `modules/auth/`.
- [ ] Inside `modules/auth/`, create `application/use-cases/`,
      `application/ports/`, `domain/`, `infrastructure/`, `presentation/`.
- [ ] Rename `auth.controller.ts` → `presentation/auth.controller.ts`.
- [ ] Rename `auth.service.ts` → `application/use-cases/login.use-case.ts`
      (split `login`, `refreshToken`, `validateUser` into separate use cases).
- [ ] Move `jwt.strategy.ts` → `infrastructure/jwt/jwt.strategy.ts`; have it
      delegate to a `TokenPort`.
- [ ] Define `TokenPort` in `application/ports/token.port.ts` and a
      `JwtTokenAdapter` in `infrastructure/jwt/jwt-token.adapter.ts`.
- [ ] Move `roles.guard.ts` → re-export from `libs/auth` (don't duplicate).
- [ ] Move proxy controllers to `modules/retail/presentation/retail.controller.ts`
      and `modules/inventory/presentation/inventory.controller.ts`.
- [ ] Replace inline DTOs with imports from `@app/contracts`.
- [ ] Replace any direct `client.send()` calls in controllers with a
      `RetailGatewayPort` / `InventoryGatewayPort` and an adapter under
      `infrastructure/messaging/`.
- [ ] Add request-correlation middleware from `@app/observability`.
- [ ] Update `app.module.ts` to register only `presentation` modules + global
      `LoggerModule.forRoot()` and `AuthModule`.
- [ ] Update `main.ts` so that the **first import** is
      `import '@app/observability/tracer';`.
- [ ] Run e2e tests for auth happy-path; CI green.

## Phase 3 — Notification Service (greenfield-style migration)

- [ ] In `apps/notification/src/`, create
      `modules/notifications/{application,domain,infrastructure,presentation}`.
- [ ] Define `NotifierPort` in `application/ports/notifier.port.ts`
      (`send(message: NotificationMessage): Promise<void>`).
- [ ] Implement `LogNotifierAdapter` in `infrastructure/delivery/`.
- [ ] Add scaffolding for `EmailNotifierAdapter` (no real SMTP yet — class
      with TODO and unit-test stub).
- [ ] Build a use case `SendOrderNotificationUseCase` consuming the
      `NotifierPort`.
- [ ] Add an `OrderEventsConsumer` in `infrastructure/consumers/` that
      subscribes to `retail.order.created` (contract from
      `@app/contracts/retail`) and invokes the use case.
- [ ] Add an `InventoryEventsConsumer` for `inventory.stock.low` →
      `SendLowStockAlertUseCase`.
- [ ] Wire the module: bind `NotifierPort` symbol → `LogNotifierAdapter`.
- [ ] Add a `/health` controller in `presentation/`.
- [ ] Write unit tests for both use cases with an in-memory `NotifierPort`
      double.
- [ ] Add e2e test that publishes a fake `OrderCreated` to RabbitMQ and
      asserts a log line via Pino test transport.
- [ ] Update `docker-compose.yml` so notification depends on rabbitmq.
- [ ] CI green.

## Phase 4 — Inventory Service Alignment

- [ ] Create `apps/inventory/src/modules/stock/{application,domain,infrastructure,presentation}`.
- [ ] Move TypeORM entity to `infrastructure/persistence/stock-item.entity.ts`.
- [ ] Create framework-free `domain/stock-item.model.ts` (pure class,
      invariants enforced in constructor).
- [ ] Create `infrastructure/persistence/stock-item.mapper.ts` (entity ↔ model).
- [ ] Define `StockRepositoryPort` in `application/ports/`.
- [ ] Implement `StockTypeormRepository` in `infrastructure/persistence/`.
- [ ] Move methods from `stock.service.ts` into use cases:
      `ReserveStockUseCase`, `ReleaseStockUseCase`, `AdjustStockUseCase`,
      `GetStockUseCase`, `ListStockUseCase`.
- [ ] Define `StockEventsPublisherPort`; implement
      `StockRabbitmqPublisher` that emits `inventory.stock.reserved` and
      `inventory.stock.low` (contracts in `@app/contracts/inventory`).
- [ ] Convert `stock.controller.ts` → `presentation/stock.controller.ts` with
      `@MessagePattern('inventory.stock.*')` and DI-injected use cases.
- [ ] Repeat the same shape for `warehouses` and `reservations`.
- [ ] Add `StockRedisCache` adapter (decorator-based) for `GetStockUseCase`.
- [ ] Unit tests against in-memory `StockRepositoryPort` for invariants.
- [ ] Integration tests with testcontainers MySQL for the Typeorm adapter.
- [ ] CI green.

## Phase 5 — Retail Service Alignment

- [ ] Repeat the Phase 4 pattern for `apps/retail/src/modules/products/`:
  - [ ] Domain `Product` model + `Price` value object.
  - [ ] Use cases: `CreateProduct`, `UpdateProduct`, `FindProduct`, `ListProducts`.
  - [ ] `ProductRepositoryPort` + `ProductTypeormRepository`.
  - [ ] `ProductEventsPublisherPort` + RabbitMQ adapter publishing
        `retail.product.created`, `retail.product.updated`.
  - [ ] `ProductRedisCache` for read paths.
- [ ] Repeat for `apps/retail/src/modules/orders/`.
- [ ] Replace `Repository<X>` injections in old services with port symbols.
- [ ] Migrate controllers to `presentation/` with `@MessagePattern`.
- [ ] Delete `services/` and `entities/` folders at the module root.
- [ ] CI green.

## Phase 6 — Cross-cutting upgrades

- [ ] Add `docker-compose.observability.yml` with `jaeger` (16686) and
      `otel-collector` (4317/4318).
- [ ] Add `OTEL_EXPORTER_OTLP_ENDPOINT` to all `.env.example` files.
- [ ] In each service's `main.ts`, ensure `import '@app/observability/tracer'`
      is the first line.
- [ ] Verify trace propagation across RabbitMQ (look for a single trace in
      Jaeger spanning gateway → retail → inventory → notification).
- [ ] Enrich Pino logs with `traceId` and `spanId` via a NestJS interceptor
      from `@app/observability`.
- [ ] Add `@Cacheable({ key: 'ris:retail:product:{id}', ttl: 60 })` to
      `FindProductUseCase` and the equivalent inventory queries; add
      invalidation on write paths.
- [ ] Enable `eslint-plugin-boundaries` rules:
      domain → no infra; application → no infra; presentation → no
      persistence; cross-service domain imports forbidden.
- [ ] Add `lint-architecture` GitHub Actions job.
- [ ] Add `docs/adr/0001…0008` ADRs (templates from `adr-tools`).
- [ ] Add `docs/architecture/overview.md` with C4 container/component
      diagrams (mermaid).
- [ ] Expand unit test coverage to ≥ 80% on `application/` and ≥ 60% on
      `infrastructure/`.
- [ ] Add a contract test (Pact-style or hand-rolled) per RabbitMQ event
      shape in `libs/contracts`.

## Phase 7 — Cleanup & polish

- [ ] Delete the deprecated re-export shim from `libs/common` (if you kept
      one in Phase 1).
- [ ] Remove dead code (old service classes, unused DTOs).
- [ ] Tag a release `v1.0.0-architecture` once all phases pass CI.
- [ ] Update README with new top-level diagram + ADR index.
- [ ] Record a short Loom/Asciinema demo of `nest g resource` against the
      module template — useful for future contributors and as portfolio
      evidence.
