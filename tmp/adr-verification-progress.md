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
- [ ] ADR-007 — Pino + OpenTelemetry Trace Correlation — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-008 — RabbitMQ via `libs/messaging` + Dotted Routing Keys — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-009 — Port/Adapter at the API Gateway — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-010 — JWT + RBAC at the Gateway — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-011 — NotifierPort + Notification Microservice Template — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-012 — Stock Aggregate + Port/Adapter Split — **PENDING**
  - [ ] code
  - [ ] tasks
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
