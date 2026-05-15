# task-09 — Write observability libraries (Phase: observability/, libs)

> This task fills the eight per-`@opentelemetry/*` library articles.
> It is split from task-08 because the combined batch exceeds the
> per-session granularity budget.

## Context

- Migration source of truth: ADR-014 (OTLP/HTTP + Jaeger), ADR-007
  (the side-effect import contract), `package.json` (the exact
  versions of each `@opentelemetry/*` dep).
- Previous carryover:
  `docs/architecture-migration-ru/tasks/_carryover-08.md`
  (READ FIRST). It carries the forward-link anchors from
  `opentelemetry-overview` and `jaeger-backend` — every link in
  those overview articles into a `lib-opentelemetry-*` slot must
  point at the slug filled in this task.
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`.
- Conventions preamble: see `task-01-survey-and-scaffold.md`.
- Where the guide stands: the four observability overview articles
  are written. This task fills the per-library section of the
  observability clarification group.

## Prerequisites

- [ ] `_carryover-08.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] HEAD SHA is recorded in `_carryover-01.md`.
- [ ] Every clarification-group library in this task is confirmed
      present in `package.json` (task-01's `## Discrepancies`
      section is empty for the OTel stack).

## Goal

Write the eight per-library `@opentelemetry/*` articles. After
reading them a reader must understand who does what:

- `@opentelemetry/api` — the public surface (`trace.getActiveSpan`,
  `trace.getTracer`) every other piece depends on.
- `@opentelemetry/sdk-node` — the `NodeSDK` boot driver in
  `libs/observability/tracer.ts`.
- `@opentelemetry/auto-instrumentations-node` — bundles the
  `http`/`mysql2`/`redis`/`amqplib`/`nestjs-core` patches.
- `@opentelemetry/instrumentation-amqplib` — the patch that injects
  `traceparent` into AMQP message properties.
- `@opentelemetry/exporter-trace-otlp-http` — ships spans over
  OTLP/HTTP to the collector at `:4318/v1/traces`.
- `@opentelemetry/core` / `@opentelemetry/resources` /
  `@opentelemetry/semantic-conventions` — the supporting layer
  every other package leans on (context manager, resource builder,
  semantic attribute keys).

## Article slots to fill

- [ ] `docs/architecture-migration-ru/observability/lib-opentelemetry-api.md`
- [ ] `docs/architecture-migration-ru/observability/lib-opentelemetry-sdk-node.md`
- [ ] `docs/architecture-migration-ru/observability/lib-opentelemetry-auto-instrumentations-node.md`
- [ ] `docs/architecture-migration-ru/observability/lib-opentelemetry-instrumentation-amqplib.md`
- [ ] `docs/architecture-migration-ru/observability/lib-opentelemetry-exporter-trace-otlp-http.md`
- [ ] `docs/architecture-migration-ru/observability/lib-opentelemetry-core.md`
- [ ] `docs/architecture-migration-ru/observability/lib-opentelemetry-resources.md`
- [ ] `docs/architecture-migration-ru/observability/lib-opentelemetry-semantic-conventions.md`

> Approximate guidance: ~700–1000 words per library article. Each
> follows the library-article shape (no separate "Концепция"
> section — fold the explanation into "Применение в проекте"). The
> "What it does NOT do" section is mandatory.
>
> - **lib-opentelemetry-api** — the public surface. `trace`,
>   `context`, `propagation`. Used directly by
>   `libs/observability/logger.module.ts` (`trace.getActiveSpan`).
> - **lib-opentelemetry-sdk-node** — `NodeSDK` constructor. The
>   `start()` call in `tracer.ts`. The SIGTERM shutdown hook.
> - **lib-opentelemetry-auto-instrumentations-node** — bundles
>   ~30 instrumentations including `http`, `mysql2`, `redis`,
>   `amqplib`, `nestjs-core`. Why require-time patching matters.
> - **lib-opentelemetry-instrumentation-amqplib** — explicitly
>   listed as a dep (alongside being part of the auto-bundle) for
>   pinning. Injects `traceparent` into AMQP message properties on
>   publish, extracts on consume. This is what makes the
>   four-service trace a single tree across RabbitMQ.
> - **lib-opentelemetry-exporter-trace-otlp-http** — OTLP-over-HTTP
>   exporter. Posts to `OTEL_EXPORTER_OTLP_ENDPOINT`
>   (`http://otel-collector:4318/v1/traces`). Why HTTP and not
>   gRPC (per ADR-014 §"Exporter").
> - **lib-opentelemetry-core** — `W3CTraceContextPropagator`,
>   context managers. Almost never imported directly; pulled in
>   transitively. The article explains why it shows up in
>   `package.json` even though the project hardly touches it
>   directly.
> - **lib-opentelemetry-resources** — `Resource` builder. Where the
>   `service.name` and `deployment.environment.name` attributes are
>   set in `tracer.ts`.
> - **lib-opentelemetry-semantic-conventions** — string constants
>   for span attribute keys (e.g.
>   `SemanticResourceAttributes.SERVICE_NAME`). Why the project
>   uses these instead of writing `'service.name'` literals.

## Steps

1. **Read previous carryover.**
2. **Read the SDK boot file.** `libs/observability/tracer.ts` is
   the only place all eight libraries touch each other in this
   project's code. Use it as the central anchor.
3. **Author each library article.** The "What it does NOT do"
   section disambiguates from neighbours
   (e.g. `lib-opentelemetry-api` says "this is not the SDK — see
   `[[lib-opentelemetry-sdk-node]]`").
4. **Code anchors** (verify in task-01):
   - `libs/observability/tracer.ts` — every library shows up here.
   - `libs/observability/logger.module.ts` (the `logMethod` hook
     uses `trace.getActiveSpan` from `@opentelemetry/api`).
   - `libs/observability/spec/logger.module.spec.ts` (uses
     `BasicTracerProvider`, `AsyncLocalStorageContextManager`).
5. **Mention `package.json` versions.** Each article cites the
   exact version range from `package.json` — OTel API surfaces
   evolve, and the article should anchor to the version the
   permalinks pin against.
6. **Cross-link** every per-library article back to
   `[[opentelemetry-overview]]` and `[[jaeger-backend]]`. Within
   the group, link sibling pairs that are commonly confused
   (`api` ↔ `sdk-node`,
   `auto-instrumentations-node` ↔ `instrumentation-amqplib`,
   `core` ↔ `resources`).

## Verification

- [ ] All eight articles filled, no `заглушка` callouts.
- [ ] Permalinks pinned to the recorded SHA on every excerpt.
- [ ] Every wiki link resolves.
- [ ] Each per-library article has a "Что это НЕ делает" section.
- [ ] No orphans.
- [ ] Each article ≥ 600 words (the floor — adapter-thin articles
      like `lib-opentelemetry-core` may sit at the floor; that is
      acceptable).

## Carryover

Write `_carryover-09.md` per the standard structure.
