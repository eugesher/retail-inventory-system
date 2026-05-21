---
id: phase-02
title: Infrastructure libs
depends_on: [phase-01]
scope_paths:
  - libs/messaging/**
  - libs/cache/**
  - libs/observability/**
  - libs/auth/**
estimated_files: 44
---

# Phase 02 — Infrastructure libs

## Goal
Apply the `simplify` skill to the four port/adapter libraries: `libs/messaging` (RabbitMQ wiring — `MessagingModule`, per-service client modules, `RabbitmqClientFactory`, `ROUTING_KEYS`, `EXCHANGES`), `libs/cache` (`ICachePort`, `RedisCacheAdapter`, `CacheModule`, `CACHE_KEYS` registry, `@Cacheable` decorator), `libs/observability` (Pino `LoggerModuleConfig` with trace-correlation hook, correlation middleware/decorator/types, OTel `tracer.ts`, `TraceContextInterceptor`, `MetricsModule`, the `testing/` deep-import barrel), and `libs/auth` (framework glue: `AuthModule.forRootAsync`, `JwtStrategy`, `JwtAuthGuard`, `RolesGuard`, decorators). Observable outcome: smaller, more uniform infrastructure surface, with every ADR-locked public shape (port surfaces, key shapes, routing-key constants, exporter wiring, guard surfaces) preserved exactly.

## You Are Running In a Clean Context
This task file is everything you have. There is no prior memory of earlier phases. You must:

1. **Read** `tmp/tasks/simplify/carryover.md` in full before doing anything else. It contains established patterns from earlier phases that you must apply consistently.
2. **Read** only the files under "Pre-read" below from `docs/adr/` and the repository.
3. **Do not** read `tmp/tasks/simplify/00-plan.md` or any other phase file — they are not part of your context.

## Pre-read
- `tmp/tasks/simplify/carryover.md` (full).
- `docs/adr/001-structured-logging-with-pino.md` — Pino + `nestjs-pino` + correlation-id middleware.
- `docs/adr/006-cache-aside-via-libs-cache.md` — introduces `ICachePort` / `RedisCacheAdapter` / `CACHE_KEYS`; preserves the ADR-002 cache-aside contract.
- `docs/adr/007-pino-and-opentelemetry.md` — co-locates Pino + OTel in `libs/observability`; locks the tracer-import-first rule for `main.ts`.
- `docs/adr/008-rabbitmq-via-libs-messaging.md` — `libs/messaging` wiring; dotted `ROUTING_KEYS` wire format.
- `docs/adr/010-jwt-rbac-at-the-gateway.md` — `libs/auth` framework-glue contract.
- `docs/adr/014-otel-exporter-otlp-http-and-jaeger.md` — OTLP/HTTP + collector + Jaeger; auto-instrumentations.
- `docs/adr/015-pino-trace-correlation.md` — Pino `logMethod` hook injects `traceId` / `spanId`.
- `docs/adr/016-cache-aside-generalized.md` — `ris:<service>:<aggregate>:<id>[:<facet>]` key convention + `delByPrefix`.
- `docs/adr/021-cache-single-flight-and-ttl-jitter.md` — adds `singleFlight(key, fn)` to `ICachePort` and ±10% jitter on stock writes.
- `docs/adr/022-cache-keys-tenant-and-schema-version.md` — adds `<version>` and opt-in `t:<tenantId>` segments to `CACHE_KEYS`.
- `docs/adr/023-cache-invalidate-post-commit-by-type.md` — replaces `invalidate` with `withInvalidation` (type-enforced post-commit ordering).
- `docs/adr/017-architecture-lint-via-eslint-boundaries.md` — boundaries rules are authoritative; `yarn lint` is the source of truth.
- Repository files in `scope_paths` above.

## Hard Constraints
Restate these in full — do not link out:

- **ADRs are immutable.** This phase must not steer the `simplify` skill toward changes that contradict ADR-001, ADR-002, ADR-006, ADR-007, ADR-008, ADR-010, ADR-014, ADR-015, ADR-016, ADR-017, ADR-018, ADR-020, ADR-021, ADR-022, ADR-023. In particular:
  - **`ICachePort` surface is frozen**: `get`, `set`, `del`, `wrap`, `delByPrefix`, `singleFlight`. No method may be renamed, removed, or have its arity changed.
  - **`CACHE_KEYS` key-shape contract is frozen**: builders emit `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`. Per-aggregate version constants (`INVENTORY_STOCK_KEY_VERSION`, `RETAIL_ORDER_KEY_VERSION`) remain string-typed constants. The `__all__` sentinel and `localeCompare`-based sort remain.
  - **The `RedisCacheAdapter.delByPrefix` reach-through to `KeyvRedis`** is the only acceptable place to reach into the cache backend (per ADR-016 §4 / ADR-006). Do not move it out, and do not introduce a second reach-through elsewhere.
  - **`ROUTING_KEYS` constants are wire format** — names, dotted shapes, and exported keys are frozen. The `EXCHANGES` constant is reserved for future topic-exchange routing; do not delete it. **Do not rename or remove a routing-key constant in this phase** — producer and consumer references span every microservice and the gateway; renaming requires the corresponding service phase(s) in the same scope, which is not the case here.
  - **OTel bootstrap remains a side-effect import** (`libs/observability/tracer.ts`), and the comment / convention that **`main.ts` must import it first** stays intact. Auto-instrumentation patches happen at module load.
  - **Pino `logMethod` hook injects `traceId` / `spanId`** into every log record (ADR-015). Preserve this hook and its behavior.
  - **`libs/observability/testing/` is intentionally NOT re-exported from `libs/observability/index.ts`** — the deep-import path `@retail-inventory-system/observability/testing` is the only legal way to reach it. Do not promote the testing barrel.
  - **`AuthModule.forRootAsync({ imports, providers, exports })`** keeps its signature. `JwtStrategy`, `JwtAuthGuard`, `RolesGuard`, `@Public`, `@Roles`, `@CurrentUser`, and the `AUTH_USER_VALIDATOR` DI symbol all keep their names.
  - **OWASP 2024 argon2id cost defaults** (referenced by `AUTH_ARGON2_*` env vars; see CLAUDE.md) remain — even though argon2 lives in the gateway, this phase must not alter the supporting types/constants in `libs/auth` in a way that breaks the gateway's hashing pipeline.
- **Behavior preservation.** Test suites listed under "Test commands" below must pass after this phase. If `simplify` removes code covered only by tests that become trivial, those tests may be removed; meaningful coverage may not be.
- **No artifacts in the code.** Do not add any comment, marker, file, or `README.md`/`CLAUDE.md` entry describing this pass. Do not append to any ADR. The only observable change to the repository is the simplifications themselves.
- **Preserve audit annotations.** Lines tagged `AUDIT-2026-05-08 [...]` and `AUDIT-2026-05-20 [...]` are load-bearing breadcrumbs and must not be deleted.
- **No deletion under `tmp/`.** Do not delete, move, or rename anything under `tmp/`.
- **No files outside `tmp/tasks/simplify/`** other than in-place code modifications produced by the skill.
- **Out of scope, always**: `migrations/**`, `tests/lint/architecture-lint.spec.ts`, `tmp/**`, `dist/**`, `coverage/**`, `node_modules/**`, root-level `task.md` / `todo.md` / `nvim.md` / `http.md` / `a.md`, `docs/**`, `README.md`, `CLAUDE.md`, ADRs, `package.json`, `tsconfig.json`, ESLint / Prettier config files, `docker-compose*.yml`, `Dockerfile`. Also out of scope this phase: all of `apps/**` and the foundational libs (`libs/common`, `libs/contracts`, `libs/ddd`, `libs/config`, `libs/database`).
- **Idempotency.** If `carryover.md` shows this phase as completed under "Phase ledger → Completed", verify the repository state matches and exit. If partially completed, resume from the documented state.

## Procedure

1. **Verify entry state.** Confirm `carryover.md` shows phase-01 under "Completed". Confirm the scope paths exist. If pre-state is inconsistent, stop and report.
2. **Run the test commands below to establish a green baseline.** If the baseline is not green, stop and report — do not proceed with simplification on top of a broken suite. Note: `yarn test:e2e` requires Docker; ensure the daemon is running before starting.
3. **Apply the `simplify` skill to the scope paths**, honoring every established pattern from carryover's "Established patterns" section and every Hard Constraint above. The four libs are independent sub-scopes; the skill may converge to different idioms in each.
4. **Run the test commands below again.** If anything regressed, address it inside this phase before proceeding. If you cannot bring tests back to green within the skill's contract, stop and report.
5. **Update `tmp/tasks/simplify/carryover.md`** per the schema:
    - Move phase-02 from "Pending" to "Completed" with a one-paragraph summary of what changed.
    - Append any newly established patterns to "Established patterns".
    - Append the list of files materially changed to "Files modified by phase → phase-02".
    - Record the test-status snapshot under "Test status checkpoints → phase-02".
    - Append any deferred items to "Open / deferred".

## Test Commands
- Lint: `yarn lint`
- Unit: `yarn test:unit`
- E2E: `yarn test:e2e` (full reload — required because this phase touches wire-format and cache-key infrastructure)

## Exit Criteria
- `[ ]` `simplify` skill applied to every path under `scope_paths`.
- `[ ]` `yarn lint` passes with `--max-warnings 0`.
- `[ ]` `yarn test:unit` passes.
- `[ ]` `yarn test:e2e` passes (full reload).
- `[ ]` `tmp/tasks/simplify/carryover.md` updated per §Procedure step 5.
- `[ ]` No new files outside `tmp/tasks/simplify/` other than in-place code modifications.
- `[ ]` No comment, marker, or documentation entry in the codebase mentions this pass.
- `[ ]` Nothing under `tmp/` deleted, moved, or renamed.
- `[ ]` `ICachePort`, `CACHE_KEYS`, `ROUTING_KEYS`, `EXCHANGES`, `AuthModule.forRootAsync` public surfaces unchanged.
- `[ ]` `libs/observability/tracer.ts` remains a side-effect-import file. `libs/observability/testing/` remains NOT re-exported from the main barrel.

## On Failure
If any step fails irrecoverably within this phase's scope, stop, leave the repository in a clean state (revert partial diffs if needed), record the failure under "Open / deferred" in the carryover document with enough detail for a human to triage (which lib, which file, which test failed, the skill's last-attempted intent), and exit without marking the phase completed.
