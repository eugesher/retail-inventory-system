# Simplification — Master Plan

> This document is for human review. Phase executors should **not** read it. They read only their own per-phase task file and `carryover.md`.

## Purpose

Orchestrate the application of the `simplify` skill across the entire `retail-inventory-system` codebase in a sequence of independent, clean-context phases. The `simplify` skill is the sole modifier of code in every phase; this plan defines only what to invoke and where.

---

## Audit findings (read-only, from the orchestration run)

### Repository shape

- **`apps/`** — 4 services, 177 `.ts` files, ~5170 production LOC + ~2601 spec LOC.
  - `api-gateway` (64 files, ~1493 prod / ~300 spec LOC) — hosts `auth` (DB-owning, 5 use-cases), `retail`, `inventory` port-and-adapter modules.
  - `inventory-microservice` (42 files, ~1590 prod / ~1512 spec LOC) — single `stock` bounded context; near 1:1 spec/prod ratio.
  - `retail-microservice` (46 files, ~1695 prod / ~574 spec LOC) — single `orders` bounded context.
  - `notification-microservice` (25 files, ~392 prod / ~215 spec LOC) — RMQ-only, canonical per-module template.
- **`libs/`** — 9 libraries, 104 `.ts` files, ~1725 production LOC + ~619 spec LOC.
  - Foundational (598 LOC, 1 spec): `common`, `contracts`, `ddd`, `config`, `database`.
  - Infrastructure (1127 LOC, 5 specs): `messaging`, `cache`, `observability`, `auth`.
- **`test/`** — 3 e2e specs (`auth`, `notification`, `system-api` with snapshot).
- **`tests/`** — `tests/lint/architecture-lint.spec.ts` — architecture-lint fixture regression suite (excluded from simplification scope; it is a bumper).
- **`scripts/`** — `migration-create.ts`, `test-db-seed.ts`, `utils/`, `bash/start-dev.sh`, `seeds/*.sql`.
- **`migrations/`** — append-only ledger per ADR-019 (excluded from simplification scope).

### ADR-derived no-go list

The following decisions are immutable and binding on every phase:

| ADR(s) | Locked |
| --- | --- |
| ADR-001, ADR-007, ADR-015 | Pino + `nestjs-pino` + OTel trace-correlation `logMethod` hook; `tracer` side-effect import first in every `main.ts`. |
| ADR-002, ADR-006, ADR-016, ADR-021, ADR-022, ADR-023 | Redis cache-aside contract; `ICachePort` + `RedisCacheAdapter` + `CACHE_KEYS`; key shape `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`; `singleFlight` + ±10% jitter; `IStockCachePort.withInvalidation` (post-commit ordering type-enforced). |
| ADR-004, ADR-009, ADR-011, ADR-012, ADR-013 | Per-module hexagonal layout in every service; `ClientProxy` confined to `infrastructure/messaging/*.adapter.ts`. |
| ADR-005, ADR-018 | NestJS monorepo with `apps/*` + `libs/*`; the split of `libs/common` into bounded libs is final. |
| ADR-008, ADR-020 | RabbitMQ as both RPC and event transport; routing-key wire format `<service>.<aggregate>.<action>`; `ROUTING_KEYS` + `EXCHANGES` constants in `libs/messaging`. |
| ADR-010 | HS256 JWT + argon2id + rotated refresh w/ reuse detection; global `JwtAuthGuard` + `RolesGuard` via `APP_GUARD`. |
| ADR-014 | OTLP/HTTP exporter → collector → Jaeger; `@opentelemetry/auto-instrumentations-node`. |
| ADR-017 | `eslint-plugin-boundaries` rules are authoritative — `yarn lint` is the source of truth. Rules may not be loosened to make a simplification pass. The fixture spec `tests/lint/architecture-lint.spec.ts` is a regression bumper. |
| ADR-019 | TypeORM + MySQL; `SnakeNamingStrategy`; `BaseEntity` ID strategy; migrations under `migrations/` are append-only. |
| ADR-003 | ADR format itself (Nygard hybrid, 3-digit padding). Phases must not steer the skill toward rewriting ADRs. |

### Coupling and shared-code inventory

- Direction: `apps/* → libs/*` only (no app-to-app code imports). Cross-service contact is wire-format: RMQ routing keys + DTOs in `libs/contracts`.
- The cross-service contract surface lives in `libs/contracts/{microservices,retail,inventory,auth}`.
- Routing-key constants live in `libs/messaging/routing-keys.constants.ts`; producer + consumer references span every microservice and every gateway adapter. **Renaming a routing-key constant is forbidden within a single phase** unless the phase scope includes both producer and consumer.
- Dependency order least→most-depended-on: `notification` → `inventory` → `retail` → `api-gateway`.

### Test invocation map

| Scope | Command |
| --- | --- |
| Unit (all) | `yarn test:unit` |
| E2E (full, with infra reload) | `yarn test:e2e` |
| E2E (assumes infra up) | `yarn test:e2e:run` |
| Infra up | `yarn test:infra:up` |
| Infra reload | `yarn test:infra:reload` |
| Lint | `yarn lint` |
| Format check | `yarn format:check` |

Skipped / xdescribe / xit / `.skip` scan returned **zero** matches. No currently-skipped tests at the start of orchestration.

### Findings

**CRITICAL** — _None._

**HIGH**
- H-1: Routing-key constants are a shared seam — renaming them in any phase requires producer and consumer in the same scope.
- H-2: `libs/contracts` is a cross-service ABI — field/type names must be held stable in phase-01.
- H-3: `AUDIT-2026-05-08 [CODE-001]` and similar audit annotations are load-bearing breadcrumbs to the 2026-05-20 follow-up audit; phases must preserve them.

**MEDIUM**
- M-1: Inventory has a near-1:1 spec/prod LOC ratio; the inventory phase's scope explicitly includes its spec siblings.
- M-2: The architecture-lint fixture spec is excluded from all phases.
- M-3: E2E reload is expensive; required for phases that touch wire-format scope (phase-02 onward) and the consolidating phase-07.

**LOW**
- L-1: `libs/observability/testing/` is intentionally not re-exported from the main barrel.
- L-2: Two routing-key registries coexist (`ROUTING_KEYS` and legacy `MicroserviceMessagePatternEnum`); the legacy enum must not be deleted by `simplify` without an explicit decision.
- L-3: `migrations/**` is excluded entirely.
- L-4: `tmp/tasks/notifications/` already exists as a sibling; `tmp/tasks/simplify/` was created without disturbing it.

---

## Approved phase table

| #  | Phase ID    | Title                       | Scope (paths)                                                                                       | Depends on   | Approx. files touched | One-line goal |
| -- | ----------- | --------------------------- | --------------------------------------------------------------------------------------------------- | ------------ | --------------------- | ------------- |
| 01 | `phase-01`  | `foundational-libs`         | `libs/common/**`, `libs/contracts/**`, `libs/ddd/**`, `libs/config/**`, `libs/database/**`          | —            | ~60                   | Apply `simplify` to the low-coupling, type-heavy libraries first; hold cross-service contract names stable. |
| 02 | `phase-02`  | `infrastructure-libs`       | `libs/messaging/**`, `libs/cache/**`, `libs/observability/**`, `libs/auth/**`                       | `phase-01`   | ~44                   | Apply `simplify` to the port/adapter libs (RMQ, Redis, Pino/OTel, JWT); preserve ADR-locked wire/key/log shapes. |
| 03 | `phase-03`  | `notification-microservice` | `apps/notification-microservice/**`                                                                 | `phase-02`   | ~25                   | Simplify the smallest, consumer-only microservice; establishes per-service conventions for downstream phases. |
| 04 | `phase-04`  | `inventory-microservice`    | `apps/inventory-microservice/**`                                                                    | `phase-03`   | ~42                   | Simplify the `stock` bounded context (4 entities, 3 use-cases, near-1:1 spec/prod ratio). |
| 05 | `phase-05`  | `retail-microservice`       | `apps/retail-microservice/**`                                                                       | `phase-04`   | ~46                   | Simplify the `orders` bounded context (5 entities, 3 use-cases, cross-service confirm RPC adapter). |
| 06 | `phase-06`  | `api-gateway`               | `apps/api-gateway/**`                                                                               | `phase-05`   | ~64                   | Simplify the gateway (`auth` + `retail` + `inventory` modules) in one pass; preserve global guards. |
| 07 | `phase-07`  | `tests-and-scripts`         | `test/**`, `scripts/**`                                                                             | `phase-06`   | ~10                   | Final sweep on e2e specs and dev scripts; full unit + e2e green closes the run. |

**Out of scope, all phases**: `migrations/**`, `tests/lint/architecture-lint.spec.ts`, `tmp/**`, `dist/**`, `coverage/**`, `node_modules/**`, root-level `task.md` / `todo.md` / `nvim.md` / `http.md` / `a.md`, `docs/**`, `README.md`, `CLAUDE.md`, ADRs, `package.json`, `tsconfig.json`, ESLint / Prettier config files, `docker-compose*.yml`, `Dockerfile`.

---

## Ordering rationale

The sequence is bottom-up. Libs ship first because every app depends on them; an app phase that landed before a lib touched would either lock itself out of a simplified lib API or have to re-touch its imports. Within libs, foundational types (`common`, `contracts`, `ddd`, `config`, `database` — 598 LOC, 1 spec) are separated from infrastructure ports (`messaging`, `cache`, `observability`, `auth` — 1127 LOC, 5 specs) because the second group concentrates Pino / OTel / RMQ / Redis / JWT wiring where the simplify skill has the most surface to work and the most ADR-locked constraints to honor. Keeping it in its own phase keeps the diff legible. Service phases run least-depended-on first (notification, then inventory, then retail, then api-gateway) so any consumer-side adjustments land before producer-side ones; the notification microservice goes first because it is the canonical per-module template (per ADR-011) and the smallest, which lets it set the per-service "shape" convention the carryover document propagates to the other three. The api-gateway is last because it bundles three modules and depends on every microservice's contract being stable. The tests-and-scripts phase consolidates: `test/*.e2e-spec.ts` exercises the full cross-service flow, so it must run after every production phase has stabilised. `migrations/**` and the architecture-lint fixture are excluded — the former is an append-only ledger, the latter is a regression bumper that exists specifically to detect drift in the rules a `simplify` pass might inadvertently weaken.

---

## Carryover content plan

Each phase appends, on exit:

- **Phase ledger** — move self from "Pending" to "Completed" with a one-paragraph what-changed summary (no per-file diff narrative; `git log` owns that).
- **Established patterns** — cross-phase conventions the skill converged on in this scope (e.g. "use `??` over `||` when nullishness, not falsiness, was meant"; "DI symbols stay in `application/ports/`; export through `index.ts`"; "test-doubles live in `…/use-cases/spec/test-doubles.ts`"). Only patterns worth applying consistently downstream.
- **Files modified by phase → phase-NN** — flat list of materially-changed files (so later phases can detect "already touched" on re-run).
- **Test status checkpoints → phase-NN** — which commands ran, pass/fail counts, any spec the skill removed (with one-line justification).
- **Open / deferred** — items the skill could not simplify within its contract, or items the executor judged out of phase scope (with the phase id where they would best land).

---

## Constraint sanity check (orchestration §4)

- `[x]` §4.1 — Scope and authority. Phases delegate to the `simplify` skill; phase task files do not direct line-by-line edits. ADR-locked decisions are restated per-phase as no-go fences.
- `[x]` §4.2 — Behavior preservation. Every phase task file lists `yarn test:unit` and `yarn lint`; phases 02–07 also list `yarn test:e2e`.
- `[x]` §4.3 — No artifacts in the code. No phase task file instructs the executor to add markers, comments, `SIMPLIFY.md`, or `README.md`/`CLAUDE.md` entries.
- `[x]` §4.4 — Clean-context execution. Each phase task file restates every constraint inline; the only external state is `tmp/tasks/simplify/carryover.md`.
- `[x]` §4.5 — No `tmp/` references in final deliverables. Phase task files cite ADR numbers (not `tmp/` paths) where they restate constraints; the codebase, `README.md`, `CLAUDE.md`, and `docs/**` are not modified by any phase.
- `[x]` §4.6 — Idempotency posture. Each phase task file has a "Verify entry state" step that checks the carryover for the phase's own completion and consistency of `depends_on`.
- `[x]` §4.7 — Nothing deleted under `tmp/`. The "Hard Constraints" section in each per-phase file restates this.
