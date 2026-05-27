---
epic: epic-00
task_number: 8
title: Rewrite `epic-02/task-01` (+ task-09) to use the shared `@retail-inventory-system/observability/tracer` import instead of an app-local `otel.setup.ts`
depends_on: []
doc_deliverable: null
---

# Task 08 — Fix `epic-02/task-01` app-local `otel.setup.ts` (ADR-007 host-rule violation)

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** Open ADR-007, ADR-014, and ADR-015 in full before editing. ADR-007 §"libs/observability is the host for both Pino and OTel" is the binding rule. CLAUDE.md §"Operational notes" states: "The first import in every app's `main.ts` MUST be `@retail-inventory-system/observability/tracer`."

## ADR audited

[ADR-007 — Pino structured logs + OpenTelemetry trace correlation](../../../docs/adr/007-pino-and-opentelemetry.md). Accepted (2026-05-10).

## Contradiction

`tmp/tasks/epic-02-catalog-product-and-variant/task-01-scaffold-catalog-microservice.md` instructs the implementer to create an app-local OTel bootstrap file at `apps/catalog-microservice/src/otel.setup.ts` and to `import './otel.setup';` as the first line of `main.ts`. This violates two ADR-007 binding rules:

1. §"`libs/observability` is the host for both Pino and OTel" — the decision explicitly co-locates OTel bootstrap in the shared library. An app-local `otel.setup.ts` would duplicate the SDK wiring (NodeSDK construction, OTLPTraceExporter wiring, auto-instrumentations) that already lives in `libs/observability/tracer.ts`.
2. §"Side-effect import for OTel bootstrap" — fixes the import as `import '@retail-inventory-system/observability/tracer';` (a deep import from the shared library). The task's `import './otel.setup';` is a relative app-local path.

Every existing microservice (api-gateway, retail, inventory, notification) imports the shared library. Adding the catalog microservice with a divergent pattern would create a five-service codebase where four follow ADR-007 and one does not — and any subsequent service that copies the catalog scaffold would inherit the violation.

Surface: `tmp/tasks/epic-02-catalog-product-and-variant/task-01-scaffold-catalog-microservice.md` + `tmp/tasks/epic-02-catalog-product-and-variant/task-09-seed-and-documentation-pass.md` (the verification line referencing the same path).

## Evidence

ADR-007 §"libs/observability is the host" (`docs/adr/007-pino-and-opentelemetry.md:31-39`):

```text
### `libs/observability` is the host for both Pino and OTel

Co-locating Pino and OTel in one library reflects that they solve
the same problem from different angles — log lines carry
`correlationId` (request scope) **and** `traceId` / `spanId` (call
graph scope), and both must be enriched at the same point in the
request lifecycle. Splitting into two libs would mean two entry
points and two trace-context plumbing paths.
```

ADR-007 §"Side-effect import for OTel bootstrap" (`docs/adr/007-pino-and-opentelemetry.md:42-50`):

```ts
import '@retail-inventory-system/observability/tracer';
import { NestFactory } from '@nestjs/core';
// …
```

Offending task instructions:

```text
tmp/tasks/epic-02-catalog-product-and-variant/task-01-scaffold-catalog-microservice.md:68:│   ├── otel.setup.ts          # tracer-first-import — MUST be imported before any @nestjs/* import in main.ts
tmp/tasks/epic-02-catalog-product-and-variant/task-01-scaffold-catalog-microservice.md:82:`main.ts` opens with `import './otel.setup';` as the very first line (matches the convention used by the existing microservices for `OTEL_SERVICE_NAME=catalog-microservice` trace routing).
tmp/tasks/epic-02-catalog-product-and-variant/task-01-scaffold-catalog-microservice.md:195:- `apps/catalog-microservice/src/otel.setup.ts`.
tmp/tasks/epic-02-catalog-product-and-variant/task-01-scaffold-catalog-microservice.md:236:5. **Tracer-first-import discipline.** Why `otel.setup.ts` is the very first line of `main.ts` (ADR-014/015): the OTel SDK must wrap the Node module loader before any Nest import.
tmp/tasks/epic-02-catalog-product-and-variant/task-09-seed-and-documentation-pass.md:102:- The boot file (`apps/catalog-microservice/src/main.ts` opens with `import './otel.setup';`).
```

The "matches the convention used by the existing microservices" claim on line 82 is **false**: every existing microservice imports the shared library, not a local file. Verified by:

```text
apps/api-gateway/src/main.ts:1:           import '@retail-inventory-system/observability/tracer';
apps/inventory-microservice/src/main.ts:1: import '@retail-inventory-system/observability/tracer';
apps/retail-microservice/src/main.ts:1:    import '@retail-inventory-system/observability/tracer';
apps/notification-microservice/src/main.ts:1: import '@retail-inventory-system/observability/tracer';
```

## Why this matters

ADR-007 sits at the top of the observability stack — every later observability ADR (ADR-014, ADR-015) layers on the assumption that there is one tracer bootstrap point. Following the task literally would:

- Duplicate ~50 lines of SDK wiring per new service (NodeSDK + OTLPTraceExporter + auto-instrumentations + diag logger + shutdown hook).
- Make the next "bump OTel SDK from x.y.z to x.y.z+1" change a five-file diff instead of one-file.
- Erode the ADR-007 single-host invariant that ADR-014 / ADR-015 rely on (their hook into "the" tracer assumes there is only one).

## Proposed resolution

Recommend **option A**.

**Option A — Rewrite the offending task lines to use the shared library import (recommended).**

The task file at `tmp/tasks/epic-02-catalog-product-and-variant/task-01-scaffold-catalog-microservice.md` is edited in five places (lines 68, 82, 195, 236) and one cross-reference in task-09 (line 102):

- Line 68 — directory diagram: delete the `otel.setup.ts` entry. The shared library already provides the tracer side-effect; no app-local file is needed.
- Line 82 — `main.ts` opening line: rewrite to `import '@retail-inventory-system/observability/tracer';` (mirroring the four existing services).
- Line 195 — "files to add" entry: delete `apps/catalog-microservice/src/otel.setup.ts`.
- Line 236 — "Tracer-first-import discipline" doc-deliverable section: rewrite to cite the shared library import and reference ADR-007 explicitly (not ADR-014/015 as the binding ADR for the import-order rule).
- `task-09:102` — verification list entry: rewrite to `The boot file (apps/catalog-microservice/src/main.ts opens with import '@retail-inventory-system/observability/tracer';).`

**Option B — Amend ADR-007 to permit per-app OTel bootstrap files.**

Rejected as the recommendation. Would require a fresh ADR (ADR-024 or similar) that supersedes ADR-007's host-rule decision, plus refactoring the four existing services to match. The disproportionate cost is the giveaway; the task wording is the cheaper thing to fix.

## Scope

**In:**

- Edit `tmp/tasks/epic-02-catalog-product-and-variant/task-01-scaffold-catalog-microservice.md` at the four listed lines (option A).
- Edit `tmp/tasks/epic-02-catalog-product-and-variant/task-09-seed-and-documentation-pass.md` at the one listed line (option A).

**Out:**

- Any change to `libs/observability/`.
- Any change to ADR-007 itself.
- Any change to existing service `main.ts` files — they already import the shared library.

## Exit criteria

- [ ] The catalog microservice scaffold task instructs the implementer to use `import '@retail-inventory-system/observability/tracer';` as the first line of `main.ts`, with no app-local `otel.setup.ts` file.
- [ ] No other task file under `tmp/tasks/**` was edited beyond the two listed above.
- [ ] `yarn lint` still passes (this task edits only `tmp/tasks/**/*.md`, a no-op for lint).
- [ ] `tmp/adr-verification-progress.md` ADR-007 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
