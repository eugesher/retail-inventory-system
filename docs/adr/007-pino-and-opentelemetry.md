# ADR-007: Pino structured logs + OpenTelemetry trace correlation

- **Date**: 2026-05-10
- **Status**: Accepted (example log shape + bootstrap narrative superseded in part by ADR-014 / ADR-015 — see References)

---

## Context

[ADR-001](001-structured-logging-with-pino.md) established Pino as
the structured logger for every service, with `correlationId` carried
on every log line and propagated via the `x-correlation-id` HTTP
header / RabbitMQ message payload. That gives us per-request
correlation across services but no trace structure: we know which
log lines belong to the same request, not which downstream call took
how long or where an error originated in the call graph.

The migration recommendation calls out OpenTelemetry as the next
observability layer. Task-10 wires the actual `NodeSDK`, exporter,
and Jaeger UI; task-04 introduces the **library shape** so app
`main.ts`s can already declare the side-effect import without
breaking when task-10 fills in the body.

This ADR documents:

1. The trace+log correlation pattern we are adopting.
2. The split of responsibilities between this ADR and ADR-001.
3. What ships in task-04 vs. task-10.

## Decision

### `libs/observability` is the host for both Pino and OTel

Co-locating Pino and OTel in one library reflects that they solve
the same problem from different angles — log lines carry
`correlationId` (request scope) **and** `traceId` / `spanId` (call
graph scope), and both must be enriched at the same point in the
request lifecycle. Splitting into two libs would mean two entry
points and two trace-context plumbing paths.

### Side-effect import for OTel bootstrap

`libs/observability/tracer.ts` is imported as a side-effect from
each service's `main.ts` **before** `NestFactory.create*()`:

```ts
import '@retail-inventory-system/observability/tracer';
import { NestFactory } from '@nestjs/core';
// …
```

OTel auto-instrumentation (`@opentelemetry/auto-instrumentations-node`)
patches HTTP, MySQL, Redis, and AMQP modules at require time. If
Nest's bootstrap runs first, the patching happens against modules
that have already been instantiated, and spans go missing. The
side-effect import is the only way to guarantee correct ordering
without an explicit pre-init script.

In task-04 the file body is empty. Task-10 fills in the SDK config
(OTLP exporter, W3C trace-context propagator, resource attributes
keyed off `AppNameEnum`).

### Pino enrichment hook for `traceId` / `spanId`

`LoggerModuleConfig.pinoHttp.hooks.logMethod` already filters noisy
Nest contexts in dev. The same hook gains a stub today (no-op
because `tracer.ts` doesn't start an SDK yet) that task-10 wires to
read `trace.getActiveSpan()?.spanContext()` and merge `trace_id` /
`span_id` into the bindings.

The output shape after task-10 will be:

```json
{
  "level": 30,
  "time": 1762000000000,
  "app": "retail-microservice",
  "context": "OrderConfirmService",
  "correlationId": "abc-123",
  "trace_id": "1a2b3c…",
  "span_id": "4d5e6f…",
  "msg": "Order confirmed"
}
```

The dual presence of `correlationId` and `trace_id` is intentional:
`correlationId` is what humans grep for (it is human-supplied via
header on test requests); `trace_id` is what Jaeger and the OTel
exporter consume.

### `TraceContextInterceptor` for response headers

A Nest interceptor copies the active span context onto Pino's
per-request bindings and (in task-10) onto the response header
(`traceparent`). The interceptor ships in task-04 as a passthrough
so app modules can already register it.

### Relationship to ADR-001

ADR-001 keeps **Status: Accepted**. This ADR does **not** supersede
it — they cover complementary concerns:

- ADR-001 owns the Pino configuration (level, redaction, transport,
  formatter), the correlation-ID middleware, and the cross-service
  propagation rule for `correlationId`.
- ADR-007 owns the trace structure, the side-effect import contract,
  and the trace+log enrichment hook.

If the two ever conflict, ADR-001 wins on log shape; ADR-007 wins on
trace plumbing.

## Consequences

- **+** App `main.ts`s can adopt the side-effect import in task-04
  and forget about it. Task-10 lands without touching app code.
- **+** Operators get one log stream + one trace stream that can be
  joined on `trace_id`. `correlationId` survives as the
  human-grepable identifier.
- **−** Two correlation identifiers per log line (one human, one
  machine). Mitigated by documenting both in the README's
  observability section.
- **−** Side-effect imports are easy to break with auto-formatters
  that re-order imports. ADR notes the import order as a hard
  requirement; CI doesn't enforce it today (lint rule scheduled for
  task-10).

## Alternatives considered

- **OTel-only, drop `correlationId`.** Rejected: loses
  human-grepability; tests already pass `x-correlation-id` for
  determinism.
- **Pino-only, defer OTel indefinitely.** Rejected: per-request
  correlation does not give per-call latency, and ADR-004 commits to
  hexagonal boundaries that benefit from explicit span structure.

---

## References

- [ADR-014](014-otel-exporter-otlp-http-and-jaeger.md) — chooses `@opentelemetry/exporter-trace-otlp-http` against a local OTel collector + Jaeger all-in-one, fills in the SDK config that this ADR's §Decision describes as a task-10 follow-up, and binds resource attributes to `process.env.OTEL_SERVICE_NAME` (Joi-enforced per service). The sentence "Task-10 fills in the SDK config (OTLP exporter, W3C trace-context propagator, resource attributes keyed off `AppNameEnum`)" in this ADR's §"Side-effect import for OTel bootstrap" is superseded here: the body is no longer empty (`libs/observability/tracer.ts` is fully populated) and resource attributes are not keyed off `AppNameEnum`.
- [ADR-015](015-pino-trace-correlation.md) — codifies the implemented enrichment as camelCase `traceId` / `spanId` on every log line emitted inside an active span, via `LoggerModuleConfig.pinoHttp.hooks.logMethod`. The example JSON block in this ADR's §"Pino enrichment hook for `traceId` / `spanId`" uses snake_case `trace_id` / `span_id`; the live shape is camelCase per ADR-015 (and CLAUDE.md §"Operational notes" cites the camelCase pair as the authority). Treat the snake_case example as historical — operators writing Loki/Grafana queries should grep for `traceId` / `spanId`.
- [ADR-001](001-structured-logging-with-pino.md) — the upstream Pino-configuration ADR (level, redaction, transport, formatter, `correlationId` middleware + RMQ propagation). This ADR explicitly does **not** supersede ADR-001; the hand-off rule in §"Relationship to ADR-001" stands — ADR-001 wins on log shape, ADR-007 wins on trace plumbing — with ADR-015 now the binding authority on the trace-field naming inside that log shape.
