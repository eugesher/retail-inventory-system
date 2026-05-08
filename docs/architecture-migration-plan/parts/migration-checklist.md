# Migration Checklist — Retail Inventory System → Hexagonal NestJS Monorepo

> Each item is concrete and reviewable as a single PR (or sub-PR). Tick boxes
> as work progresses. **Do not start any phase before the previous one is
> green in CI.** Re-scoped against the live tree on 2026-05-08; items that
> were already done in the repo before this plan landed have been removed,
> and items the plan missed have been added. Phase numbers map to the task
> queue under `docs/architecture-migration-plan/tasks/`.

## Phase 0 — Preparation (task-02)

- [ ] Capture `nest-cli.json`, `tsconfig.json`, `package.json`,
      `docker-compose.yml`, `eslint.config.mjs`, `jest.unit.config.js`,
      `jest.e2e.config.js`, `webpack.config.js` to `docs/baseline/` for
      diffable reference. (Branch already exists as
      `RIS-25-Architecture-migration` — no new branch operation.)
- [ ] Capture coverage baseline (`yarn test:unit --coverage`) to
      `docs/baseline/coverage.txt`.
- [ ] `yarn add -D eslint-plugin-boundaries` — install only; rules
      stay disabled until Phase 6.
- [ ] Add ADR-NNN "Adopt hexagonal architecture per service" (ADR
      number = next free under 3-digit padding; this is **not** the
      same as ADR-003 created in task-01, which records the ADR
      format choice).
- [ ] `yarn install && yarn build && yarn lint && yarn test:unit` — green.

## Phase 1 — Shared Library Restructuring (task-03 + task-04)

The existing repo has four libs (`common`, `config`, `inventory`, `retail`).
This phase splits and re-targets them into the recommendation's lib set.
Already-implemented patterns (cache-aside, correlation IDs, Joi config)
are **relocated**, not rebuilt.

### Foundation (task-03)

- [ ] Create `libs/contracts` (Nest library or hand-rolled —
      verify the Yarn-4 + Nest-CLI scaffolder cooperates first).
      Migrate cross-service DTOs, payloads, and message-pattern enum
      out of `libs/inventory`, `libs/retail`, and `libs/common/enums`.
- [ ] Create `libs/database`. Move
      `libs/config/typeorm-module.config.ts` and the
      `SnakeNamingStrategy` re-export into it. Add `BaseEntity`
      (`id`, `createdAt`, `updatedAt`, `deletedAt`).
- [ ] Slim `libs/common` to pure utilities only: `result.ts`,
      `exceptions/`, `pagination/`, `types/`. Move correlation
      middleware out (to `libs/observability` in task-04), move
      cache helpers out (to `libs/cache` in task-04), move
      microservice client modules out (to `libs/messaging` in
      task-04), move enums out (to `libs/contracts` here).
- [ ] Update `tsconfig.json` `paths` with the new lib aliases under
      the existing `@retail-inventory-system/<name>` prefix; mirror
      the additions in `jest.unit.config.js`, `jest.e2e.config.js`,
      and `nest-cli.json`'s `projects` block.
- [ ] Repoint every consumer of moved symbols. The apps must still
      compile.

### Integration (task-04)

- [ ] Create `libs/messaging`. Move `MicroserviceClientRetailModule`
      / `MicroserviceClientInventoryModule` and the
      `MicroserviceClientConfiguration` factory from `libs/common`.
      Migrate `MicroserviceMessagePatternEnum` (currently
      `inventory_product_stock_get`-style snake_case) to dotted
      `<service>.<aggregate>.<event>` constants. Compatibility map
      from old → new is recorded in `_carryover-04.md`.
- [ ] Create `libs/cache`. Move `libs/common/cache/cache.helper.ts`;
      define `CachePort` (`get`, `set`, `del`, `wrap`); add
      `RedisCacheAdapter` wrapping the existing
      `@nestjs/cache-manager` + `@keyv/redis` setup. Move the
      `cacheModuleConfig` from `libs/config/cache-module.config.ts`
      into `libs/cache/cache.module.ts`. Add a `@Cacheable`
      decorator and a `cache-keys.ts` registry.
- [ ] Create `libs/observability`. Move `libs/common/correlation`
      (middleware + decorator + constants). Add `tracer.ts` shell
      (OTel `NodeSDK` boot — finished in task-11). Move
      `libs/config/logger-module.config.ts` into
      `libs/observability/logger.module.ts`.
- [ ] Create `libs/ddd` — framework-free `entity.base.ts`,
      `aggregate-root.base.ts`, `value-object.base.ts`,
      `domain-event.base.ts`, `repository.port.ts`. No `@nestjs/*`,
      no TypeORM.
- [ ] `libs/config` retains the Joi `configModuleConfig` (env
      schema). Other configs (cache, logger, typeorm) have moved to
      their dedicated libs.
- [ ] Add ADRs (3-digit padding, next free numbers): cache-aside
      generalization, RabbitMQ routing-key convention, Pino + OTel
      pairing.

## Phase 2 — API Gateway Layer Alignment (task-05)

- [ ] In `apps/api-gateway/src/`, create `modules/` directory.
- [ ] Reshape `app/api/order/` → `modules/retail/...` and
      `app/api/product/` → `modules/inventory/...` (since both are
      proxy modules toward downstream services).
- [ ] Define `RetailGatewayPort` and `InventoryGatewayPort` in
      `modules/<svc>/application/ports/`. Implement adapters in
      `modules/<svc>/infrastructure/messaging/`. Replace direct
      `ClientProxy.send()` calls in services with port-method
      invocations.
- [ ] Replace inline DTOs with `@retail-inventory-system/contracts`
      imports.
- [ ] Add request-correlation middleware import from
      `@retail-inventory-system/observability` (currently lives in
      `libs/common/correlation`).
- [ ] Make `import '@retail-inventory-system/observability/tracer';`
      the first line of `apps/api-gateway/src/main.ts`.
- [ ] Run `test/system-api.e2e-spec.ts` end-to-end — must stay green.

## Phase 3 — Build Auth from Scratch (task-06)

The repo has **no** auth today (no `@nestjs/jwt`/`passport` deps,
no guards, no strategies). Building auth is in scope for this
migration as a dedicated task. See `task-06-build-auth-from-scratch.md`.

- [ ] Add deps: `@nestjs/jwt`, `@nestjs/passport`, `passport`,
      `passport-jwt`, `bcrypt` (or `argon2`). Update
      `libs/config/config-module.config.ts` Joi schema with auth env
      vars (`JWT_SECRET`, `JWT_EXPIRES_IN`, `JWT_REFRESH_EXPIRES_IN`).
- [ ] Create `libs/auth` (Nest library): `jwt.strategy.ts`,
      `roles.guard.ts`, `@CurrentUser()` decorator, `@Public()`
      decorator, `auth.module.ts` exposing the strategy + guard.
- [ ] In `apps/api-gateway/src/modules/auth/`, build the hexagonal
      auth module:
      - `domain/user.model.ts`, `domain/role.model.ts`
      - `application/use-cases/{login,refresh-token,validate-user}.use-case.ts`
      - `application/ports/token.port.ts`,
        `application/ports/user.repository.port.ts`
      - `infrastructure/jwt/jwt-token.adapter.ts`,
        `infrastructure/persistence/user-typeorm.repository.ts`
        (a `User` TypeORM entity is added under
        `infrastructure/persistence/`)
      - `presentation/auth.controller.ts` + login/refresh DTOs
- [ ] Add a `User` migration under `migrations/`.
- [ ] Apply `JwtAuthGuard` globally in `apps/api-gateway/src/app/app.module.ts`;
      annotate `/auth/login`, `/auth/refresh` with `@Public()`.
- [ ] Add unit tests for each use case (in-memory port doubles).
- [ ] Add an E2E flow in `test/system-api.e2e-spec.ts` (or a new
      `test/auth.e2e-spec.ts`): unauthenticated requests are rejected;
      a successful login + token returns from a protected route.
- [ ] Add ADR-NNN "JWT + RBAC at the gateway".
- [ ] Add a "Authentication" section to `README.md` (login/refresh
      flow, env vars, RBAC roles).
- [ ] Update `CLAUDE.md` "Known Issues" — auth is no longer absent.

## Phase 4 — Notification Service (task-07)

The notification service is the empty stub in
`apps/notification-microservice/`. Phase 4 builds it correctly the
first time and uses it as the canonical per-module template.

- [ ] Create `modules/notifications/{application,domain,infrastructure,presentation}`.
- [ ] Define `NotifierPort` (`send(message): Promise<void>`).
- [ ] Implement `LogNotifierAdapter` (default) and scaffold
      `EmailNotifierAdapter`, `WebhookNotifierAdapter` (no SMTP yet).
- [ ] Build `SendOrderNotificationUseCase` and
      `SendLowStockAlertUseCase`.
- [ ] Add `OrderEventsConsumer` (listens to `retail.order.created`
      via `@MessagePattern` / `@EventPattern`) and
      `InventoryEventsConsumer` (listens to `inventory.stock.low`).
      Pattern strings come from `@retail-inventory-system/messaging`
      constants — no inline literals.
- [ ] Wire `notifications.module.ts`: bind `NOTIFIER` symbol →
      `LogNotifierAdapter`; import `MessagingModule`,
      `LoggerModule`.
- [ ] Add a `health.controller.ts` in `presentation/`.
- [ ] Update `apps/notification-microservice/src/main.ts` so the
      first import is the observability tracer.
- [ ] Unit tests for both use cases (in-memory `NotifierPort`).
      E2E: publish a fake `OrderCreated` event and assert a
      Pino log line.
- [ ] Update `CLAUDE.md` Known Issues — notification is no longer a
      stub. Add a note pointing at `modules/notifications/` as the
      canonical module template.

## Phase 5 — Inventory Service Alignment (task-08)

The current layout is `apps/inventory-microservice/src/app/api/product-stock/providers/<feature>-<action>.service.ts` plus a `common/modules/product-stock-common/` shared façade. Phase 5 reshapes this into per-module hexagonal layout while preserving the working cache-aside that ADR-002 documents.

- [ ] Create `modules/stock/{application,domain,infrastructure,presentation}`.
- [ ] Move TypeORM entities (`product`, `product-stock`,
      `product-stock-action`, `storage`) from
      `app/common/entities/` to
      `modules/stock/infrastructure/persistence/*.entity.ts`.
- [ ] Add framework-free `domain/stock-item.model.ts` (constructor
      enforces `quantity >= 0` etc.) and a
      `infrastructure/persistence/stock-item.mapper.ts`.
- [ ] Define `StockRepositoryPort`,
      `StockEventsPublisherPort`. Implement
      `StockTypeormRepository` and `StockRabbitmqPublisher`.
- [ ] Move `ProductStockGetService` →
      `application/use-cases/get-stock.use-case.ts` and
      `ProductStockOrderConfirmService` →
      `application/use-cases/reserve-stock-for-order.use-case.ts`.
- [ ] Relocate `product-stock-common.service.ts` (façade) and its
      sub-providers (`-add`, `-get`, `-cache`) into
      `modules/stock/infrastructure/`. The cache-aside contract from
      ADR-002 is preserved; only the file paths and imports change.
      Update ADR-002 status to "Superseded by …" if invalidation
      semantics change; otherwise leave it Accepted with a pointer.
- [ ] Migrate the `@MessagePattern` handlers
      (`INVENTORY_PRODUCT_STOCK_GET`, `INVENTORY_ORDER_CONFIRM`) into
      `presentation/stock.controller.ts`. Pattern strings now come
      from `@retail-inventory-system/messaging`.
- [ ] Unit tests against in-memory `StockRepositoryPort` for
      invariants. Existing 6 product-stock specs (59 of the 59 unit
      tests today) are migrated alongside their service files; spec
      paths follow the new module layout.
- [ ] `grep -r '@Entity' apps/inventory-microservice/src` — only
      hits under `modules/stock/infrastructure/persistence/`.
- [ ] `grep -r 'Repository<' apps/inventory-microservice/src` —
      only hits under `infrastructure/persistence/`.

## Phase 6 — Retail Service Alignment (task-09)

The retail service has only one feature today (orders). It also has
a partial domain (`app/api/order/domain/order-confirm.domain.ts`
with a unit spec). Phase 6 expands that into a proper aggregate.

- [ ] Create `modules/orders/{application,domain,infrastructure,presentation}`.
- [ ] Move TypeORM entities (`customer`, `order`, `order-product`,
      `order-status`, `order-product-status`) from
      `app/common/entities/` to
      `modules/orders/infrastructure/persistence/`.
- [ ] Build `domain/order.model.ts` (Order aggregate),
      `domain/order-product.model.ts`,
      `domain/order-status.value-object.ts`. Migrate
      `OrderConfirmDomain`'s state-transition logic into the
      aggregate's `confirm(...)` method or into a dedicated
      `confirm-order.specification.ts`.
- [ ] Define `OrderRepositoryPort`,
      `OrderEventsPublisherPort`,
      `InventoryConfirmGatewayPort`. Implement adapters under
      `infrastructure/`.
- [ ] Move per-action services into use cases:
      `order-create.service.ts` → `create-order.use-case.ts`,
      `order-confirm.service.ts` → `confirm-order.use-case.ts`,
      `order-get.service.ts` → `get-order.use-case.ts`. Use cases
      no longer inject `Repository<Order>` or `ClientProxy` — they
      depend on ports.
- [ ] Migrate `@MessagePattern` handlers into
      `presentation/orders.controller.ts`.
- [ ] Update the existing `order-confirm.domain.spec.ts` to test
      the new aggregate `confirm()` method; add use-case specs for
      the new ports.
- [ ] `grep -r 'Repository<' apps/retail-microservice/src` — only
      hits under `infrastructure/persistence/`.
- [ ] `grep -r 'ClientProxy' apps/retail-microservice/src` — only
      hits under `infrastructure/messaging/`.

> Retail has no products module today. If a retail-side product
> aggregate is introduced later, it becomes a new task created at
> that time — not a reserved slot in this migration queue.

## Phase 7 — Cross-cutting upgrades (task-10 + task-11 + task-12 + task-13)

### Observability — task-10

- [ ] Add `docker-compose.observability.yml` (jaeger,
      otel-collector + collector config under
      `infrastructure/otel-collector-config.yaml`).
- [ ] Add OTel deps:
      `@opentelemetry/{sdk-node,api,auto-instrumentations-node,exporter-trace-otlp-http}`,
      optionally `@opentelemetry/instrumentation-amqplib`.
- [ ] Flesh out `libs/observability/tracer.ts` with `NodeSDK`,
      `OTLPTraceExporter`, env-driven config
      (`OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_SERVICE_NAME`),
      SIGTERM shutdown hook.
- [ ] Inject `traceId` / `spanId` into Pino via a mixin in
      `libs/observability/logger.module.ts`.
- [ ] Verify trace propagation through RabbitMQ
      (`amqp-connection-manager` is already a dep). Drive an
      order-confirm flow and capture the Jaeger trace ID in
      `_carryover-11.md`.

### Cache generalization — task-11

- [ ] Apply `@Cacheable` to remaining cache-friendly read use cases
      (e.g. `get-order.use-case.ts`).
- [ ] Centralize cache keys in `libs/cache/cache-keys.ts` —
      builders per aggregate. Migrate the existing
      `stock:<productId>:...` template into this registry.
- [ ] Add invalidation hooks in write use cases.
- [ ] Address the open audit items where they intersect cache
      generalization (CACHE-001 stampede protection,
      CACHE-003 schema-version segment, CACHE-009 tenant prefix —
      audit at `docs/audits/audit-2026-05-08.md`).

### Architecture lint — task-12

- [ ] Switch `eslint-plugin-boundaries` rules on. Encode the
      Section 3 boundary rules as `boundaries/element-types`. Fix
      every violation that the rules surface; carry any unfixable
      ones explicitly in `_carryover-12.md`.
- [ ] Extend `.github/workflows/ci-cd.yml` with a dedicated
      architecture-lint job (or rely on the existing `lint`
      step — decide based on whether boundaries-only output is
      worth a separate job).

### ADR back-fill — task-13

- [ ] Write structural ADRs that no per-task work covered:
      monorepo-with-apps-and-libs, hexagonal-per-service,
      typeorm-mysql-as-persistence, rabbitmq-as-bus,
      contracts-and-ddd-lib-split. Renumber check across the
      catalogue. Write `docs/adr/index.md`.

## Phase 8 — Cleanup & polish (task-14)

- [ ] Remove deprecation shims from `libs/common/index.ts` if
      task-03 left any.
- [ ] Remove dead code (old `*.service.ts` files supplanted by
      `*.use-case.ts`, unused entities, unused DTOs).
- [ ] Resolve every `(verify in task-01)` annotation that any
      earlier task did not close.
- [ ] README polish — top-level diagram refreshed, ADR index linked,
      "Authentication" / "Observability" / "Caching" sections
      consistent with current state.
- [ ] CLAUDE.md polish — no stale "Known Issues" lines; the
      per-module hexagonal layout is the only described pattern;
      lint rules are described as authoritative.
- [ ] Final verification (`yarn install && yarn build && yarn lint &&
      yarn test:unit && yarn test:e2e`).
- [ ] Propose a release tag and merge strategy in
      `_carryover-14.md`. (The human applies the tag; the AI does
      not run `git tag` / `git push` — see preamble item 2 in
      `task-01`.)
- [ ] After the human merges, the human deletes `tasks/` and every
      `_carryover-NN.md`. The migration is complete.
