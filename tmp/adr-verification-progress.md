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
- [ ] ADR-004 — Hexagonal Architecture per Service — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-005 — Split `libs/common` into Bounded Libs — **PENDING**
  - [ ] code
  - [ ] tasks
- [ ] ADR-006 — Cache-Aside via `libs/cache` — **PENDING**
  - [ ] code
  - [ ] tasks
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
