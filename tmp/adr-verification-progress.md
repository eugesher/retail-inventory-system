# ADR Verification Progress

Tracks the resumable ADR-accuracy audit. Each ADR has two sub-boxes:

- `code` — verified against the real codebase under `apps/**` + `libs/**`.
- `tasks` — verified against decomposed task bodies/examples/acceptance criteria under `tmp/tasks/**`.

Status legend:

- `PENDING` — not yet processed.
- `CONFIRMED-CLEAN` — both surfaces verified, no discrepancies.
- `HAS-CORRECTIONS` — at least one finding filed under `tmp/tasks/epic-00/`.

## ADRs

- [x] ADR-001 — Structured Logging with Pino and Correlation IDs — **HAS-CORRECTIONS** (epic-00/task-01, epic-00/task-03)
  - [x] code
  - [x] tasks
- [x] ADR-002 — Redis Cache-Aside for Product Stock — **HAS-CORRECTIONS** (epic-00/task-02)
  - [x] code
  - [x] tasks
- [x] ADR-003 — Record Architecture Decisions — **HAS-CORRECTIONS** (epic-00/task-03 covers the ADR-001 Date-line gap that ADR-003 mandates)
  - [x] code
  - [x] tasks
- [x] ADR-004 — Hexagonal Architecture per Service — **HAS-CORRECTIONS** (epic-00/task-04)
  - [x] code
  - [x] tasks
- [x] ADR-005 — Split `libs/common` into Bounded Libs — **CONFIRMED-CLEAN**
  - [x] code
  - [x] tasks
- [x] ADR-006 — Cache-Aside via `libs/cache` — **HAS-CORRECTIONS** (epic-00/task-05)
  - [x] code
  - [x] tasks
- [x] ADR-007 — Pino + OpenTelemetry Trace Correlation — **HAS-CORRECTIONS** (epic-00/task-06, epic-00/task-08)
  - [x] code
  - [x] tasks
- [x] ADR-008 — RabbitMQ via `libs/messaging` + Dotted Routing Keys — **HAS-CORRECTIONS** (epic-00/task-07, epic-00/task-09, epic-00/task-10)
  - [x] code
  - [x] tasks
- [x] ADR-009 — Port/Adapter at the API Gateway — **CONFIRMED-CLEAN**
  - [x] code
  - [x] tasks
- [x] ADR-010 — JWT + RBAC at the Gateway — **HAS-CORRECTIONS** (epic-00/task-11)
  - [x] code
  - [x] tasks
- [x] ADR-011 — NotifierPort + Notification Microservice Template — **CONFIRMED-CLEAN**
  - [x] code
  - [x] tasks
- [x] ADR-012 — Stock Aggregate + Port/Adapter Split — **HAS-CORRECTIONS** (epic-00/task-12)
  - [x] code
  - [x] tasks
- [ ] ADR-013 — Order Aggregate + Cross-Service Confirm — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-014 — OTLP/HTTP Export + Jaeger — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-015 — Pino Trace Correlation (`traceId`/`spanId`) — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-016 — Generalized Cache-Aside — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-017 — Architecture Lint via `eslint-plugin-boundaries` — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-018 — NestJS Monorepo (`apps/` + `libs/`) — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-019 — TypeORM + MySQL — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-020 — RabbitMQ as Inter-Service Bus — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-021 — Cache Single-Flight + TTL Jitter — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-022 — Cache Keys Tenant + Schema Version — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-023 — Post-Commit Cache Invalidation by Type — **PENDING**
  - [ ] code
  - [ ] tasks

## Findings log

### Session 2026-05-26 — ADR-001, ADR-002, ADR-003

Surfaces checked: A (codebase under `apps/**` + `libs/**`) and B (decomposed tasks under `tmp/tasks/**`).

**ADR-001** — Structured Logging with Pino.
- Code: 5 binding rules CONFIRMED (no `console.*` outside the intentional OTel-shutdown call; `PinoLogger.assign` only at gateway, inline `correlationId` in microservices; outbound RMQ payloads extend `ICorrelationPayload`; redaction wired; `LOG_LEVEL` env-driven). 1 CODE-DISCREPANCY — ADR-001 prose locates `LoggerConfig` at `libs/config/logger/logger.config.ts` but the real file is `libs/observability/logger.module.ts` (relocated by ADR-005/ADR-007). Filed as `epic-00/task-01-adr-001-add-supersession-pointer-for-logger-relocation.md`.
- Tasks: 1 ALREADY-FIXED (Prompt 1) — `Logger → PinoLogger` remediation commit `a08abfd` already rewrote task-07 of epic-01 + task-03 / task-04 of epic-02 to use `PinoLogger`. No remaining TASK-CONTRADICTIONs.

**ADR-002** — Redis Cache-Aside for Product Stock.
- Code: 4 binding rules CONFIRMED (bypass via `scope` / `ignoreCache` in `get-stock.use-case.ts:45`; warn-and-swallow at `stock.cache.ts:49,66,155`; post-commit invalidation type-enforced via `IStockCachePort.withInvalidation`; TTL as safety net). 1 CODE-DISCREPANCY — ADR-002 prose still cites `ProductStockCommonService`, `CacheHelper.keys.productStock`, `stock:<productId>:*` key shape, and fire-and-forget invalidation, all superseded by ADR-006/016/021/022/023. Filed as `epic-00/task-02-adr-002-add-supersession-pointer-for-cache-evolution.md`.
- Tasks: no TASK-CONTRADICTIONs. `epic-04/task-06-bump-cache-key-version-v1-to-v2-rewrite-stock-cache.md` describes the v2 bump and explicitly preserves post-commit invalidation (line 246 of `epic-04/task-04-rewrite-stock-item-domain-aggregate-as-stock-level.md` and lines 87/195 of `epic-03/task-03-pricing-use-cases-set-schedule-select.md` explicitly enforce "after commit, not before").

**ADR-003** — Record Architecture Decisions.
- Code: 5 rules CONFIRMED (3-digit padding 001-023, no gaps; slugs name the decision; no in-place ADR edits in `git log`; numbers allocated at first commit). 1 CODE-DISCREPANCY — ADR-001 lacks the `**Date**` header line ADR-003 §Format mandates. Filed as `epic-00/task-03-adr-001-add-date-header.md`.
- Tasks: no TASK-CONTRADICTIONs. `task-10` of epic-01 explicitly notes "no new ADR is required". All inspected task files include the `## Required reading` block mandated by recent RIS-44 work.

**Summary for this session:**
- 3 ADRs processed.
- 3 CODE-DISCREPANCIES filed (all under epic-00).
- 0 non-ALREADY-FIXED TASK-CONTRADICTIONs.
- 1 ALREADY-FIXED (Prompt 1) acknowledged for ADR-001 tasks.
- 20 ADRs remain (ADR-004 through ADR-023).

### Session 2026-05-26 (batch 2) — ADR-004, ADR-005, ADR-006

Surfaces checked: A (codebase under `apps/**` + `libs/**`) and B (decomposed tasks under `tmp/tasks/**`, all four epics).

**ADR-004** — Hexagonal Architecture Per Service.
- Code: 5 binding rules CONFIRMED (four-layer module split present in 6 modules; `domain/` clean of `@nestjs/*` / TypeORM / `class-validator`; use-cases end in `*.use-case.ts`; adapters end in `*.adapter.ts` / `*.repository.ts` / `*.publisher.ts`; cross-module imports go through `@retail-inventory-system/*`). 1 CODE-DISCREPANCY — ADR-004 lines 70 and 96 locate ports under `domain/ports/`, but every `ports/` directory in the repo sits under `application/ports/` (`find apps -type d -name ports` returns 6 hits, all in `application/`). Every downstream ADR (009/011/012/013) plus CLAUDE.md treat `application/ports/` as the binding rule. Filed as `epic-00/task-04-adr-004-correct-ports-location-from-domain-to-application.md`.
- Tasks: no TASK-CONTRADICTIONs. All decomposed tasks (e.g. `epic-01/task-05:83`, `epic-01/task-02:77`) use `application/ports/`, matching the live code and superseding ADR-004's stale wording.

**ADR-005** — Split `libs/common` into Bounded Libs.
- Code: 7 rules CONFIRMED (`libs/contracts` with sub-areas; `libs/database` exports `BaseEntity` / `BaseTypeormRepository` / `SnakeNamingStrategy` / `DatabaseModule.forRoot/forFeature`; slimmed `libs/common` keeps only `result` / `exceptions` / `pagination` / `types`; three shims removed in task-14 — `libs/inventory` and `libs/retail` deleted, `TypeormModuleConfig` deleted; flat lib layout with no `src/` / no `tsconfig.lib.json` / no entry in `nest-cli.json` `projects`; `BaseEntity` uses `@PrimaryGeneratedColumn()` + soft-delete `@DeleteDateColumn`). 1 MINOR-INACCURACY (not load-bearing) — ADR-005 line 99-101 claims "all 8 existing entities already use auto-increment integer PKs", but `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/storage.entity.ts:5` uses `@PrimaryColumn({ type: 'varchar', length: 36 })`. The binding decision (BaseEntity strategy itself) still holds. 1 INCOMPLETE-COMMITMENT (also not load-bearing) — ADR-005 line 119-120 promised BaseEntity retrofit "in task-08 / task-09"; `grep "extends BaseEntity" apps libs` returns nothing. Both items recorded here for the log; no correction task filed.
- Tasks: no TASK-CONTRADICTIONs. No task places Nest DI decorators in `libs/contracts`. No task switches `BaseEntity`'s PK strategy. New task-introduced entities (`epic-01/task-01:100` RoleEntity char(36), `epic-04/task-02:153` StockLocation varchar(64)) use string PKs but do not extend `BaseEntity`, so they fall outside ADR-005's BaseEntity-scoped strategy decision.

**ADR-006** — Cache-aside via `libs/cache` Port and Adapter.
- Code: 6 rules CONFIRMED (`CACHE_PORT` DI symbol at `libs/cache/cache.port.ts:4`; `RedisCacheAdapter` `@Injectable()` over `@nestjs/cache-manager` + `@keyv/redis`; `CacheModule` binds `CACHE_PORT → RedisCacheAdapter`; `cacheModuleConfig` relocated from `libs/config` to `libs/cache/cache-module.config.ts`; `CACHE_KEYS` registry exists at `libs/cache/cache-keys.ts:54`; `@Cacheable` decorator exists at `libs/cache/decorators/cacheable.decorator.ts`). 1 CODE-DISCREPANCY (compound) — ADR-006 §Decision table and §"Relationship to ADR-002" describe four facts that are all superseded: `ICachePort` four-method surface (now six: `delByPrefix` + `singleFlight` added by ADR-016 / ADR-021), key prefix `stock:<productId>:` (now `ris:[t:<tenantId>:]inventory:stock:v1:<productId>` per ADR-016 + ADR-022), `*` sentinel (now `__all__`), and SCAN+UNLINK fire-and-forget invalidation (now `IStockCachePort.withInvalidation` post-commit per ADR-023). ADR-006 has no `## References` section — no forward graph for the reader. Filed as `epic-00/task-05-adr-006-add-supersession-pointer-for-port-surface-and-key-shape-evolution.md`.
- Tasks: no TASK-CONTRADICTIONs. All decomposed task examples consistently use `ICachePort` / `CACHE_PORT` / `CACHE_KEYS.*` / `@Cacheable`. The only `CacheHelper` references in tasks are about its **deletion** in `epic-04/task-06-bump-cache-key-version-v1-to-v2-rewrite-stock-cache.md` (lines 135/319/342). No app or task imports `@nestjs/cache-manager` or `@keyv/redis` directly.

**Summary for this batch:**
- 3 ADRs processed (ADR-004, ADR-005, ADR-006).
- 2 CODE-DISCREPANCIES filed (epic-00/task-04, epic-00/task-05).
- 0 TASK-CONTRADICTIONs.
- 1 minor factual inaccuracy + 1 incomplete commitment noted on ADR-005 — neither load-bearing; no correction task filed.
- 17 ADRs remain (ADR-007 through ADR-023).

### Session 2026-05-26 (batch 3) — ADR-007, ADR-008, ADR-009

Surfaces checked: A (codebase under `apps/**` + `libs/**`) and B (decomposed tasks under `tmp/tasks/**`, all four feature epics + epic-00).

**ADR-007** — Pino structured logs + OpenTelemetry trace correlation.
- Code: 5 binding rules CONFIRMED (`libs/observability` hosts both Pino + OTel; side-effect import `@retail-inventory-system/observability/tracer` is the first line of all four `main.ts` files; `logMethod` hook at `libs/observability/logger.module.ts:66-78` reads active-span context; `TraceContextInterceptor` is a no-op passthrough at `libs/observability/trace-context.interceptor.ts:8-12`; `MicroserviceMessagePatternEnum` kept for back-compat). 2 CODE-DISCREPANCIES — (a) ADR-007 example JSON (line 73-84) uses snake_case `trace_id`/`span_id`, but live code emits camelCase `traceId`/`spanId` (`logger.module.ts:78`), and ADR-015 codifies camelCase as binding; (b) ADR-007 says resource attrs are keyed off `AppNameEnum`, but `tracer.ts:31` keys them off `process.env.OTEL_SERVICE_NAME`. 1 STALE-NARRATIVE folded in (`task-10 fills body` future-tense). All filed as `epic-00/task-06-adr-007-fix-example-log-shape-trace-id-camel-case.md`. 1 TASK-CONTRADICTION — `epic-02/task-01-scaffold-catalog-microservice.md:68,82,195,236` + `epic-02/task-09:102` instruct creating an app-local `apps/catalog-microservice/src/otel.setup.ts` and `import './otel.setup';`. Violates ADR-007 §"`libs/observability` is the host"; every existing microservice uses the shared library import. Filed as `epic-00/task-08-epic-02-task-01-otel-setup-violates-libs-observability-host-rule.md`.

**ADR-008** — RabbitMQ wiring via `libs/messaging` + dotted routing keys.
- Code: 5 binding rules CONFIRMED (exports table 1-for-1 in `libs/messaging/index.ts`; dotted `<service>.<aggregate>.<action>` routing keys in `routing-keys.constants.ts`; lock-step regression test at `libs/messaging/spec/routing-keys.constants.spec.ts`; Plan A flip executed — only the dotted form survives; `MicroserviceMessagePatternEnum` kept). 1 STALE-NARRATIVE folded in (table line 37 lists only Retail + Inventory client modules; `MicroserviceClientNotificationModule` was added by ADR-011). Filed as `epic-00/task-07-adr-008-add-references-section-and-fold-notification-client-module-stale-narrative.md`. 2 TASK-CONTRADICTIONs — (a) `epic-03/task-03:159` registers a new `@MessagePattern(MicroserviceMessagePatternEnum.CATALOG_PRICE_SET)` — both the wrong surface (new keys must go in `ROUTING_KEYS` per ADR-008 §Decision table) and a value that doesn't exist in the enum (`MicroserviceMessagePatternEnum` has only retail/inventory/notification entries); filed as `epic-00/task-09-epic-03-task-03-pricing-replace-legacy-enum-with-routing-keys.md`. (b) `epic-04/task-07:54-95` instructs the implementer to inject `ClientProxy` directly into `AutoInitStockLevelUseCase` (an `application/use-cases/` file), contradicting ADR-008 §"Domain code depends on a publisher port (deferred)" — the deferred window has closed in live code. Task-08 of the same epic immediately fixes the violation but the contradiction lives in task-07's instructions. Filed as `epic-00/task-10-epic-04-task-07-08-collapse-clientproxy-use-case-into-publisher-port.md`, recommending the two tasks be collapsed.

**ADR-009** — Port-and-adapter split at the API gateway.
- Code: 9 binding rules CONFIRMED (per-module hexagonal split under `apps/api-gateway/src/modules/{retail,inventory,auth}`; gateway retail + inventory have no `domain/`, only `auth` does; `ClientProxy` only in `infrastructure/messaging/*-rabbitmq.adapter.ts` — `grep ClientProxy apps/api-gateway/src/modules/` returns only the two adapter files; `OrderConfirmPipe` injects `RETAIL_GATEWAY_PORT`, not `ClientProxy`; `IRetailGatewayPort.getOrderStatus(id)` exists; `common/utils/throw-rpc-error.util.ts` present; `main.ts` first import is `observability/tracer`; modules named after downstream service not URL).
- Tasks: 0 TASK-CONTRADICTIONs. New gateway adapters in `epic-02/task-06` and `epic-04/task-09` follow the fresh-write rule — `ClientProxy` is injected only into adapter files, and adapters use `ROUTING_KEYS.*` (not the legacy enum). The two TASK-CONTRADICTIONs that touch the gateway's wider boundary surface are filed under ADR-007 / ADR-008, not here.

**Summary for this batch:**
- 3 ADRs processed (ADR-007, ADR-008, ADR-009).
- 2 CODE-DISCREPANCIES filed (one task: epic-00/task-06 covers both ADR-007 items + the stale-narrative fold).
- 3 TASK-CONTRADICTIONs filed (epic-00/task-08 for ADR-007, epic-00/task-09 + epic-00/task-10 for ADR-008).
- 0 ALREADY-FIXED in this batch.
- 1 stale-narrative item folded into the ADR-008 amend task (epic-00/task-07).
- ADR-009 is CONFIRMED-CLEAN — the only ADR in this batch with no findings.
- 14 ADRs remain (ADR-010 through ADR-023).

### Session 2026-05-26 (batch 4) — ADR-010, ADR-011, ADR-012

Surfaces checked: A (codebase under `apps/**` + `libs/**`) and B (decomposed tasks under `tmp/tasks/**`, all four feature epics + epic-00).

**ADR-010** — JWT authentication and RBAC at the API gateway.
- Code: 12 binding rules CONFIRMED (HS256 JWT, separate `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` ≥32 + distinct via Joi `invalid(ref)`; argon2id with OWASP costs env-tunable; refresh rotation with reuse detection that clears the live hash on mismatch; `User` aggregate + `DatabaseModule.forRoot([UserEntity])` in the gateway; global `JwtAuthGuard` + `RolesGuard` as `APP_GUARD`; `@Public()` only on `/auth/login` + `/auth/refresh`; `RoleEnum = 'admin' | 'customer'`; `RegisterUserUseCase` unit-tested but not HTTP-exposed; `GET /auth/admin/ping` smoke endpoint; `IJwtAccessPayload` shape in `libs/contracts/auth`). 0 CODE-DISCREPANCIES.
- Tasks: 1 TASK-CONTRADICTION — `tmp/tasks/epic-01-baseline-identity-staffuser-customer-rbac/task-10-…:41` declares "no new ADR is required", but epic-01 substantively replaces ADR-010's RBAC model: (a) task-04 adds a third global guard `PermissionsGuard` (ADR-010 §5 commits to a 2-guard pipeline); (b) task-02 + task-05 split `User` into `StaffUser` + `Customer` aggregates with different lifecycles (ADR-010 §4 is unitary); (c) task-01 introduces a relational `role`/`permission`/`role_permissions`/`staff_user_roles` schema and four seeded roles via an IAM admin controller (ADR-010 Consequences fixes `RoleEnum` at two values and treats role addition as a three-file edit); (d) task-05 ships `POST /auth/customer/register` as `@Public()` without rate-limiting / email-verification / CAPTCHA (ADR-010 §7 explicitly defers public registration until those three exist). Per ADR-003 cadence, a new "RBAC v2" ADR (or amendment chain on ADR-010) is required. Filed as `epic-00/task-11-epic-01-task-10-rbac-claims-no-new-adr-but-supersedes-adr-010.md`.

**ADR-011** — NotifierPort + notification microservice as the per-module template.
- Code: 10 binding rules CONFIRMED (canonical 4-layer module layout under `modules/notifications/`; `INotifierPort` + `NOTIFIER` as `Symbol`; `LogNotifierAdapter` is the default `useExisting` binding; `EmailNotifierAdapter` + `WebhookNotifierAdapter` scaffolds throw "not implemented"; consumers under `infrastructure/consumers/`; `IRetailOrderCreatedEvent` + `IInventoryStockLowEvent` framework-free in `libs/contracts/{retail,inventory}/events/` extending `ICorrelationPayload` with an `occurredAt` ISO string; RMQ-only — `@MessagePattern(ROUTING_KEYS.NOTIFICATION_HEALTH_PING)`; inline `correlationId` log field on `@EventPattern`-handler paths; `NOTIFICATION_EVENTS` queue + reserved `EXCHANGES.NOTIFICATION` constant; lock-step `ROUTING_KEYS` + `MicroserviceMessagePatternEnum` spec). 0 CODE-DISCREPANCIES.
- Tasks: 0 TASK-CONTRADICTIONs. `epic-04/task-08` reshapes `IInventoryStockLowEvent` payload from `productId`/`storageId` to `variantId`/`stockLocationId` but keeps it framework-free with `occurredAt` + `ICorrelationPayload` — a planned wire-shape evolution that does not violate any ADR-011 binding rule. ADR-011 is **CONFIRMED-CLEAN** — the only ADR in this batch with no findings.

**ADR-012** — Stock aggregate and the inventory port/adapter split.
- Code: 8 binding rules CONFIRMED (single `stock` bounded context at `apps/inventory-microservice/src/modules/stock/`; `StockItem` plain class with the three invariants `quantity ≥ 0` / `reservedQuantity ≥ 0` / `reservedQuantity ≤ quantity`; `Storage` is `ValueObject<{id:string}>` rejecting empty strings; the three events extend `DomainEvent<number>`; `IStockRepositoryPort` exposes the six listed methods; `StockTypeormRepository extends BaseTypeormRepository`; `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD = 5` in `libs/contracts/inventory/inventory.constants.ts`; events emit from the use case — `StockItem` is not an `AggregateRoot`). 5 CODE-DISCREPANCIES, all stale-narrative drift from later ADRs (016 / 021 / 022 / 023) + the post-ADR `ITransactionPort` introduction: (i) §3 names the cache adapter `StockRedisCache` — live class is `StockCache` at `stock.cache.ts:22`; (ii) §3 says the adapter "reaches through `@nestjs/cache-manager` + `@keyv/redis`" — live adapter delegates to `CACHE_PORT` per ADR-016 (and CLAUDE.md §"Cache-key convention" now forbids the direct imports); (iii) §3 "SCAN+UNLINK contract verbatim + named-key fallback" — superseded by `delByPrefix` (ADR-016) + `withInvalidation` (ADR-023); (iv) §3 "three application ports" — live `ports/` directory has four (the post-ADR `transaction.port.ts` partially ring-fences `ARCH-LINT-EX-01`); (v) §4 + §8 "post-commit fire-and-forget invalidation" + "`AUDIT-2026-05-08 [CACHE-NNN]` annotations preserved verbatim" — both replaced (post-commit is now type-enforced via `withInvalidation` per ADR-023; the verbatim audit comments became supersession references at `stock.cache.ts:17-20`, with the audit register closed in CLAUDE.md §"Operational notes"). All five folded into `epic-00/task-12-adr-012-add-supersession-pointer-for-stock-cache-port-and-adapter-evolution.md`.
- Tasks: 0 TASK-CONTRADICTIONs. The epic-04 stock reshape (`StockItem → StockLevel`, `productId → variantId`, version column, etc.) is a planned future evolution that honors every ADR-012 binding rule (domain isolation, port/adapter split, ports under `application/ports/`, framework-free domain, event-from-use-case emission).

**Summary for this batch:**
- 3 ADRs processed (ADR-010, ADR-011, ADR-012).
- 5 CODE-DISCREPANCIES filed (all under one task: `epic-00/task-12`, per the supersession-pointer folding pattern).
- 1 TASK-CONTRADICTION filed (`epic-00/task-11` for ADR-010 — epic-01's RBAC v2 design needs a new ADR).
- 0 ALREADY-FIXED in this batch.
- ADR-011 is **CONFIRMED-CLEAN** — the only ADR in this batch with no findings.
- 11 ADRs remain (ADR-013 through ADR-023).
