# ADR-015: Pino log lines carry OTel `traceId` / `spanId`

- **Date**: 2026-05-14
- **Status**: Accepted (the "not installed today" sentence in §"Field naming" is dated; see References)

---

## Context

[ADR-001](001-structured-logging-with-pino.md) standardized
Pino-via-`nestjs-pino` with `correlationId` on every line — the
human-grepable identifier that survives across services because the
gateway middleware propagates it. [ADR-007](007-pino-and-opentelemetry.md)
committed to OpenTelemetry for *trace structure* (per-call latency,
parent/child span tree). [ADR-014](014-otel-exporter-otlp-http-and-jaeger.md)
wired the actual SDK + collector + Jaeger.

Once OTel is live, every Pino log line emitted inside a server-side
handler has a corresponding *active span* — but Pino does not know
that. Without further wiring, logs carry `correlationId` and traces
carry `traceId`, and the two systems live in separate planes. The
operator's question "which logs belong to this trace?" requires
either (a) joining on `correlationId` *and* searching the trace by
its own ID separately, or (b) wiring the IDs together.

This ADR records option (b): every Pino log line is enriched with the
active span's `traceId` and `spanId` so log queries can be filtered
by trace.

## Decision

### Enrichment lives in `LoggerModuleConfig.pinoHttp.hooks.logMethod`

The hook already existed — it suppressed noisy framework contexts in
dev. We extend it to:

1. Resolve `trace.getActiveSpan()?.spanContext()` on every log call.
2. If the span context is valid (non-zero `traceId` / `spanId`), merge
   `{ traceId, spanId }` into the first argument when it is a record,
   or prepend a new bindings record when it is a plain string.
3. If no span is active (e.g. logs emitted during boot, before any
   request enters the system), pass the call through unchanged — no
   `traceId: undefined` noise.

The hook is the right seam because:

- It runs **per log call**, not per request. Pino's other enrichment
  options (`customProps`, `mixin`) all fire per-record but `customProps`
  is computed once at startup and shared across calls. `logMethod`
  guarantees the `getActiveSpan()` call happens at the same moment
  Pino is about to write — which is when the OTel async context is
  the one we want.
- It composes naturally with the existing "drop noisy framework
  contexts" branch — both run on every record.
- It is library code: every service inherits the behavior from
  `LoggerModuleConfig` without app-side wiring.

### Field naming: `traceId` and `spanId`, not `trace_id` / `span_id`

ADR-007's example payload uses `trace_id` / `span_id` (snake_case,
matching OTel's wire-format conventions). We deliberately diverge to
camelCase because:

- Every other field on a Pino log line in this project is camelCase
  (`correlationId`, `userId`, `orderId`). A snake_case pair would
  read as a foreign body in `jq` queries.
- Auto-instrumentations that decorate logs themselves (e.g. when
  `instrumentation-pino` is added later) emit `trace_id` /
  `span_id`. Having both shapes co-exist on the same line is
  acceptable — operators can grep either; OTel-aware sinks
  understand the snake_case pair without configuration.

If the project later opts into `@opentelemetry/instrumentation-pino`
(which auto-injects `trace_id`/`span_id` without our hook), this hook
becomes redundant and is removed. Today the auto-instrumentation
package is not installed.

### `correlationId` stays — they answer different questions

Two identifiers per log line is intentional:

| Field | Source | Lifetime | Use |
| --- | --- | --- | --- |
| `correlationId` | gateway middleware or client header | full request, single hop or many | human grep, deterministic test assertions |
| `traceId` | OTel context (`trace.getActiveSpan()`) | one trace, may include multiple correlationIds in batch flows | join logs ↔ Jaeger UI |

A request can technically have one `correlationId` and one `traceId`
that map 1:1 today — but batched / scheduled flows in the future may
emit multiple traces under a single `correlationId`, and conversely a
trace started in a long-running background job has no `correlationId`
at all. Keeping both decouples those cases without forcing a redesign.

### No HTTP response header for `traceparent` today

`TraceContextInterceptor` is shipped as a placeholder. The auto-
instrumentation already injects the W3C `traceparent` header on
outbound HTTP responses for the routes it patches. Adding our own
header mutation on top would risk shadowing the OTel-emitted value.
If a custom shape is ever needed, the interceptor body lands at that
time.

### Unit test asserts the contract

`libs/observability/spec/logger.module.spec.ts` constructs a real
`BasicTracerProvider`, registers an `AsyncLocalStorageContextManager`,
starts a span via `context.with(...)`, and asserts the hook output
carries the matching `traceId` / `spanId`. A second test asserts the
hook is a passthrough when no span is active. This is the smallest
behaviour-anchoring test that guards the contract — anything more
involved is the integration of the SDK with Jaeger, which belongs in
a smoke test rather than this unit suite.

## Consequences

- **+** Every log line that runs inside a request handler joins
  trivially to the trace tree in Jaeger.
- **+** Logs emitted during boot (no span) stay clean — no
  `traceId: undefined` noise.
- **+** No app-side wiring: every service inherits the behaviour from
  `LoggerModuleConfig`.
- **−** Two correlation identifiers per log line. The README and
  ADR-007 both document this; operators learn the distinction once.
- **−** Field naming diverges from the OTel default (`trace_id`
  vs `traceId`). Documented; reversible if a sink prefers snake_case.
- **−** The hook calls into the OTel API on every log emission. The
  call is `O(1)` and returns `undefined` when no SDK is registered,
  so unit tests that don't bootstrap the SDK pay no real cost.

## Alternatives considered

- **`@opentelemetry/instrumentation-pino`.** Auto-injects
  `trace_id` / `span_id`. Rejected today because it adds a dependency
  and overrides Pino's hook configuration in subtle ways; the
  hand-rolled hook composes cleanly with the existing "drop noisy
  framework contexts" filter. We will revisit if the manual hook ever
  drifts.
- **OTel log signal (`@opentelemetry/sdk-logs`).** Routes logs into
  the OTel pipeline alongside traces. Larger change, harder
  story for log-aggregator compatibility, and gains us little while
  Pino + Jaeger already cover the operator's queries.
- **Drop `correlationId` after OTel lands.** Rejected: tests assert on
  `correlationId` for determinism (the client picks the value), and
  operators have been trained on it since ADR-001.

## References

- **§"Field naming" — "Today the auto-instrumentation package is not
  installed".** Dated. `@opentelemetry/instrumentation-pino@0.64.0`
  is in `yarn.lock`, pulled transitively by
  `@opentelemetry/auto-instrumentations-node@^0.76.0` (a direct
  dependency in `package.json`). `libs/observability/tracer.ts`
  activates the full `getNodeAutoInstrumentations()` bundle without
  disabling any member, so `instrumentation-pino` patches Pino at
  boot and injects snake_case `trace_id` / `span_id` onto every
  record inside an active span. The custom `logMethod` hook in
  `libs/observability/logger.module.ts` is **not** redundant — it is
  the only source of the camelCase `traceId` / `spanId` pair the
  rest of the codebase greps for, and the §"Field naming"
  coexistence trade-off the ADR anticipates ("Having both shapes
  co-exist on the same line is acceptable") is already in
  production logs.
- [ADR-014](014-otel-exporter-otlp-http-and-jaeger.md) — the SDK
  bootstrap that registers the auto-instrumentations bundle, which
  is the activation seam for `instrumentation-pino`.
- [ADR-007](007-pino-and-opentelemetry.md) — the parent decision
  committing to Pino + OTel; a subsequent revision already amends its
  example log shape from snake_case to camelCase.
