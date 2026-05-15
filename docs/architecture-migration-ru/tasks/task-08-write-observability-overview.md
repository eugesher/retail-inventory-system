# task-08 — Write observability overview (Phase: observability/, concepts)

> Observability is the third clarification group; it splits into two
> tasks (overview here, per-library articles in task-09) because the
> combined batch is ~12 articles — too much for a single cleared
> context.

## Context

- Migration source of truth: ADR-001 (Pino),
  ADR-007 (Pino + OTel pairing), ADR-014 (OTLP/HTTP + Jaeger),
  ADR-015 (Pino `traceId`/`spanId` enrichment).
- Previous carryover:
  `docs/architecture-migration-ru/tasks/_carryover-07.md`
  (READ FIRST).
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`.
- Conventions preamble: see `task-01-survey-and-scaffold.md`.
- Where the guide stands: caching and auth (the first two
  clarification groups) are written. Their stack-overview articles
  are the model this group follows.

## Prerequisites

- [ ] `_carryover-07.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] HEAD SHA is recorded in `_carryover-01.md`.

## Goal

Write the four overview articles for the observability group:
OpenTelemetry overview, Pino logging, trace-log correlation, Jaeger
as the backend. These are the conceptual scaffolding; task-09 fills
the eight per-`@opentelemetry/*` library articles.

## Article slots to fill

- [ ] `docs/architecture-migration-ru/observability/opentelemetry-overview.md`
- [ ] `docs/architecture-migration-ru/observability/pino-logging.md`
- [ ] `docs/architecture-migration-ru/observability/trace-log-correlation.md`
- [ ] `docs/architecture-migration-ru/observability/jaeger-backend.md`

> Approximate guidance:
>
> - **opentelemetry-overview** — ~2500 words. Spans, traces, context
>   propagation (W3C `traceparent`), resource attributes, exporters,
>   collectors. The side-effect import rule from ADR-007 / ADR-014:
>   `import '@retail-inventory-system/observability/tracer';` is the
>   first line of every `main.ts`. Why auto-instrumentations have to
>   patch modules at require-time.
> - **pino-logging** — ~2000 words. Anchor to ADR-001. Structured
>   JSON, `nestjs-pino`, redaction, `pino-pretty` in dev,
>   `LOG_LEVEL`, the `correlationId` thread via `x-correlation-id`
>   header + `CorrelationMiddleware`. Cite the `LoggerModuleConfig`
>   in `libs/observability/logger.module.ts`.
> - **trace-log-correlation** — ~1800 words. Anchor to ADR-015. The
>   `logMethod` hook that injects active-span `traceId` / `spanId`
>   on every log record. The intentional camelCase vs OTel's
>   default `trace_id` / `span_id` snake_case. Why both
>   `correlationId` and `traceId` coexist.
> - **jaeger-backend** — ~1800 words. Anchor to ADR-014. The
>   `docker-compose.observability.yml` overlay, the otel-collector
>   between apps and Jaeger, OTLP/HTTP `:4318` vs OTLP/gRPC `:4317`,
>   Jaeger UI at `:16686`. The
>   `infrastructure/otel-collector-config.yaml` pipeline. Switching
>   to a vendor (Honeycomb, Tempo, Datadog) is a collector-config
>   change, not an app change.

## Steps

1. **Read previous carryover.**
2. **Read the source ADRs.** ADR-001, ADR-007, ADR-014, ADR-015 in
   full.
3. **Author each article.** Anchors (verify paths in task-01):
   - **opentelemetry-overview**: `libs/observability/tracer.ts` (the
     side-effect module), `apps/api-gateway/src/main.ts` (the
     first-import rule in practice).
   - **pino-logging**: `libs/observability/logger.module.ts`,
     `libs/observability/http-context.middleware.ts`,
     `libs/observability/correlation-id.decorator.ts`,
     `libs/observability/correlation.constants.ts`.
   - **trace-log-correlation**:
     `libs/observability/logger.module.ts` (the `logMethod` hook),
     `libs/observability/spec/logger.module.spec.ts` (the unit test
     that asserts the contract).
   - **jaeger-backend**: `docker-compose.observability.yml`,
     `infrastructure/otel-collector-config.yaml` (verify path),
     the per-service `OTEL_*` env vars in `docker-compose.yml`.
4. **Mention `amqplib` instrumentation** in
   `opentelemetry-overview` and `jaeger-backend` — the
   `@opentelemetry/instrumentation-amqplib` module is what makes the
   four-service trace a single tree across RabbitMQ. Task-09 will
   detail that library; this overview points to it via
   `[[lib-opentelemetry-instrumentation-amqplib]]`.
5. **Cross-link** to `[[message-vs-event-patterns]]`,
   `[[routing-keys-and-contracts]]` (correlation thread),
   `[[shared-libs-philosophy]]`. Forward-link to every
   `lib-opentelemetry-*` slot from the OTel overview so when
   task-09 fills them, the wiki links resolve.

## Verification

- [ ] Four articles filled, no `заглушка` callouts.
- [ ] Permalinks pinned to the recorded SHA.
- [ ] Every wiki link resolves (including the eight forward-links to
      `lib-opentelemetry-*` slots that task-09 will fill — those
      already exist as stubs from task-01).
- [ ] No orphans.

## Carryover

Write `_carryover-08.md` per the standard structure.
