# ADR-014: OTLP/HTTP export to a local Jaeger via an OpenTelemetry collector

- **Date**: 2026-05-14
- **Status**: Accepted

---

## Context

[ADR-007](007-pino-and-opentelemetry.md) committed the project to
OpenTelemetry as the distributed-trace layer and froze the *shape* of
the bootstrap — a side-effect `libs/observability/tracer.ts` imported as
the first line of every service's `main.ts`, plus a Pino `logMethod`
hook that enriches log records with `traceId` / `spanId`. Task-04
shipped the empty shell; task-10 fills in the body.

That leaves four concrete questions:

1. Which **exporter protocol** do the SDKs use to ship spans out of the
   Node processes?
2. Where do those spans land in local development?
3. How does production wire to a vendor backend without changing app
   code?
4. How is the resulting trace propagated across the **four** services
   we ship today (gateway → retail → inventory → notification), given
   that three of the four hops cross a RabbitMQ queue?

This ADR records the answers.

## Decision

### Exporter: OTLP/HTTP, not OTLP/gRPC or Jaeger-thrift

`libs/observability/tracer.ts` uses
`@opentelemetry/exporter-trace-otlp-http`. The endpoint is read from
`OTEL_EXPORTER_OTLP_ENDPOINT` and must end in `/v1/traces`. We pick
HTTP over gRPC for three reasons:

- **Simpler boot footprint.** OTLP/HTTP is a single dependency
  (`exporter-trace-otlp-http`); gRPC drags in `@grpc/grpc-js`, native
  build steps, and protobuf code generation. None of that pays off in
  Node services that already speak HTTP everywhere.
- **Easier debugging.** The exporter ships JSON-over-HTTP to
  `:4318`. `curl -X POST` against the collector reproduces what the
  SDK sends; `tcpdump` against gRPC is harder for casual triage.
- **Identical end-state.** The collector turns OTLP/HTTP into anything
  downstream — Jaeger, Tempo, Honeycomb, etc. The hot-path latency
  difference between HTTP and gRPC is negligible at our volumes.

We do **not** use the Jaeger-thrift exporter. That format is legacy
and Jaeger itself now accepts OTLP natively.

### Local sink: Jaeger all-in-one behind a collector

The local stack is two containers:

```
apps (host or compose) ──OTLP/HTTP──► otel-collector:4318 ──OTLP──► jaeger:4317
                                                                       │
                                                                       └─► Jaeger UI :16686
```

The collector is **not** strictly necessary for local development —
Jaeger all-in-one accepts OTLP directly. We keep it because:

- It mirrors the production topology: apps never talk directly to a
  vendor; they talk to a sidecar collector that owns batching,
  retries, and the upstream protocol. Skipping the collector locally
  would mean two different graphs to debug.
- The `batch` processor in the collector smooths bursty workloads.
  Local tests sometimes fire dozens of spans in a few hundred
  milliseconds; batching avoids per-span HTTP roundtrips.
- The collector's `debug` exporter prints every span the apps emit to
  stdout, which is the fastest way to confirm the SDK is wired.

The collector config lives at
`infrastructure/otel-collector-config.yaml` and is a single pipeline:
OTLP receiver → `batch` processor → OTLP exporter (`tls.insecure: true`)
to `jaeger:4317`, with a `debug` exporter teed in.

### Compose overlay, not main `docker-compose.yml`

Jaeger and the collector live in a separate
`docker-compose.observability.yml`. Bring them up with:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up
```

Reasons to keep them off the default stack:

- They are **opt-in**: most local-dev sessions don't need them, and
  the Jaeger image alone is ~250MB.
- They share the `backend` network that the main compose file
  defines, so service-to-service URLs (`otel-collector:4318`) work
  unchanged when the overlay is up.
- Tests that don't care about tracing don't pay the boot cost.

### Production: same SDK, different collector destination

In production, every service still publishes OTLP/HTTP to a
collector. The collector configuration changes — its exporter ships to
a vendor (Honeycomb / Tempo / Datadog) instead of Jaeger — and the
apps remain unchanged: a single
`OTEL_EXPORTER_OTLP_ENDPOINT` env override switches the host. This is
the canonical OTel topology and is the reason ADR-007 picked OTLP-
through-a-collector over direct vendor SDKs.

### Auto-instrumentations cover the whole call graph

`@opentelemetry/auto-instrumentations-node` patches the modules every
service hits: `http`, `mysql2`, `redis`, `amqplib`, `nestjs-core`, and
others. The amqplib hooks specifically inject `traceparent` into AMQP
message properties on publish and extract it on consume — which is
how the four-service trace stays a single trace across RabbitMQ.

`amqp-connection-manager` (in `package.json`) is a wrapper around
`amqplib`; the underlying channels are real amqplib Channel objects,
so the instrumentation patches them transparently. A manual smoke
test for task-10 confirmed: a `PUT /api/order/:id/confirm` request
produces a trace with spans from all four services, including the
`publish` / `process` pairs for `retail_queue`, `inventory_queue`,
and `notification_events`.

### Required environment variables

| Var | Default | Notes |
| --- | --- | --- |
| `OTEL_SERVICE_NAME` | (required) | Distinct per service; tags every span via the `Resource` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (required) | OTLP/HTTP traces endpoint (`…/v1/traces`) |
| `OTEL_RESOURCE_ATTRIBUTES` | optional | Free-form k=v list merged into the `Resource` |
| `OTEL_SDK_DISABLED` | `false` | Set to `true` to short-circuit the bootstrap — used in some test contexts |

Joi enforces the first two as required at boot. Missing values fail
fast — they do not silently drop traces.

### Span enrichment is the auto-instrumentation's responsibility

We do **not** ship a manual `@Span()` decorator at the use-case layer.
The auto-instrumentation produces a span for every Nest controller,
every Nest microservice handler, every TypeORM query, every Redis
call, and every AMQP publish/process. The resulting tree is already
the shape we want (gateway HTTP → AMQP publish → retail handler →
AMQP publish → inventory handler → AMQP publish → notification
handler, plus DB / Redis children at each level). If a custom span is
ever needed (e.g. to wrap a non-instrumented library), the use case
can call `trace.getTracer('app').startActiveSpan(...)` — but that
remains the exception, not the rule.

## Consequences

- **+** Single command brings up tracing locally:
  `docker compose -f docker-compose.yml -f docker-compose.observability.yml up`.
- **+** Production switches by changing the collector destination, not
  app code.
- **+** The four-service trace flows for free across RabbitMQ;
  no explicit context-extraction code at adapter boundaries.
- **−** The collector adds one hop in dev. Acceptable cost for
  topology parity with prod and for the visible-debug output.
- **−** Two `Resource` attribute keys (`service.name` and
  `deployment.environment.name`) are hand-rolled instead of relying on
  `OTEL_RESOURCE_ATTRIBUTES`. Trivially refactorable later.
- **−** Auto-instrumentation can produce noisy spans for trivial
  middleware (`middleware - patched`). The Jaeger UI surfaces them
  prominently. We accept the noise for now; sampling /
  span-attribute-based filtering is a follow-up.

## Alternatives considered

- **Direct vendor SDKs** (Datadog `dd-trace`, Honeycomb beelines).
  Rejected: locks the codebase to one vendor; deviates from ADR-007's
  vendor-neutral commitment.
- **Jaeger-thrift exporter, no collector.** Rejected: legacy format;
  production almost certainly won't ship to a Jaeger instance.
- **OTLP/gRPC.** Rejected for reasons above. We can switch by
  changing one dependency and one env var if the trace volume grows.
- **No tracing, keep correlation IDs only.** Rejected by ADR-007.
  Correlation IDs answer "which logs belong to this request"; spans
  answer "where did the latency go" and "where did the error
  originate" — both questions show up in the cross-service confirm
  flow we now have.

---

## References

- [ADR-007](007-pino-and-opentelemetry.md) — the
  Pino-plus-OpenTelemetry shape this ADR fills in.
- [ADR-015](015-pino-trace-correlation.md) — Pino log lines pick up
  the `traceId`/`spanId` produced by the SDK wired here.
- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — the RabbitMQ
  transport the `amqplib` auto-instrumentation propagates
  `traceparent` across.
