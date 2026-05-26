---
epic: epic-00
task_number: 6
title: Amend ADR-007's example log shape — `trace_id`/`span_id` → `traceId`/`spanId`, plus fold stale `task-10` future-tense narrative
depends_on: []
doc_deliverable: null
---

# Task 06 — Amend ADR-007 example log shape + fold stale "task-10 fills body" narrative

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** Open ADR-007, ADR-015, and ADR-003 in full before deciding the wording. ADR-015 codifies the implemented camelCase field shape (`traceId` / `spanId`); ADR-007's pre-implementation example needs a supersession pointer rather than an in-place rewrite. CLAUDE.md §"Operational notes" is the live authority on how trace identifiers appear on log lines.

## ADR audited

[ADR-007 — Pino structured logs + OpenTelemetry trace correlation](../../../docs/adr/007-pino-and-opentelemetry.md). Accepted (2026-05-10).

## Discrepancy

ADR-007's §Decision shows an example log shape using snake_case `trace_id` / `span_id`, framed as "the output shape **after** task-10". Task-10 has shipped; the implementer chose camelCase `traceId` / `spanId`, and [ADR-015](../../../docs/adr/015-pino-trace-correlation.md) codifies that camelCase choice as the binding rule.

A reader following ADR-007 literally would either:

1. Grep production logs for `trace_id` / `span_id` and conclude trace correlation is broken (the fields exist, just under different names), or
2. Try to align a downstream consumer (Loki/Grafana queries, a log alert) on the wrong key names.

The same ADR-007 §Decision also says "In task-04 the file body is empty. Task-10 fills in the SDK config (OTLP exporter, W3C trace-context propagator, **resource attributes keyed off `AppNameEnum`**)". Two stale sub-facts inside that sentence:

- The "body empty / task-10 fills it" framing is now historical — `libs/observability/tracer.ts` is fully populated.
- Resource attributes are NOT keyed off `AppNameEnum`. The live code (`libs/observability/tracer.ts:31`) keys them off `process.env.OTEL_SERVICE_NAME ?? 'unknown-service'`, and [ADR-014](../../../docs/adr/014-otel-exporter-otlp-http-and-jaeger.md) is the binding ADR for the OTLP exporter wiring.

Per the user's audit guidance, these stale-narrative items are folded into this single ADR-007 amend task rather than getting their own correction tasks.

Surface: `docs/adr/007-pino-and-opentelemetry.md` (the ADR prose itself).

## Evidence

ADR-007 example block (`docs/adr/007-pino-and-opentelemetry.md:73-84`):

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

Real code (`libs/observability/logger.module.ts:75-78`):

```ts
const spanContext = trace.getActiveSpan()?.spanContext();
if (spanContext?.traceId && spanContext.spanId) {
  const enrichment = { traceId: spanContext.traceId, spanId: spanContext.spanId };
```

CLAUDE.md §"Operational notes" cites the camelCase shape: "Pino log lines emitted inside an active span carry `traceId`/`spanId`".

ADR-007 §Decision (`docs/adr/007-pino-and-opentelemetry.md:60-62`):

```text
In task-04 the file body is empty. Task-10 fills in the SDK config
(OTLP exporter, W3C trace-context propagator, resource attributes
keyed off `AppNameEnum`).
```

Real code (`libs/observability/tracer.ts:30-43` — excerpted):

```ts
const SDK_DISABLED = process.env.OTEL_SDK_DISABLED === 'true';

if (!SDK_DISABLED) {
  // …
  const serviceName = process.env.OTEL_SERVICE_NAME ?? 'unknown-service';
  // …
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: serviceName,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment,
  });
```

No `AppNameEnum` reference in `libs/observability/tracer.ts` (verified by `grep AppNameEnum libs/observability/tracer.ts` → no output).

## Why this matters

ADR-007 is the foundational ADR for log+trace correlation. The example block is the most-copied artifact from the ADR (operators paste it into log-query playbooks). The field-name mismatch silently breaks every such playbook. The `AppNameEnum` claim, while less load-bearing, is the kind of false fact that erodes trust in the ADR catalogue when a reader greps for `AppNameEnum` and finds nothing.

This is the same supersession-pointer pattern already filed for ADR-001 (epic-00/task-01) and ADR-002 (epic-00/task-02).

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-007's Status line + extend its (currently absent) References section (recommended).**

ADR-003 line 62 permits "flipping its `Status` and adding a one-line pointer." Use that allowance:

- Replace `**Status**: Accepted` with `**Status**: Accepted (log-shape example + bootstrap narrative superseded — `traceId` / `spanId` per [ADR-015](015-pino-trace-correlation.md); OTLP / Jaeger wiring per [ADR-014](014-otel-exporter-otlp-http-and-jaeger.md))`.
- Add a `## References` section at the end (ADR-007 has none today), listing:
  - `[ADR-014](014-otel-exporter-otlp-http-and-jaeger.md)` — the OTLP exporter + Jaeger wiring decision that fills the `tracer.ts` body referenced in §Decision.
  - `[ADR-015](015-pino-trace-correlation.md)` — the implemented camelCase `traceId` / `spanId` field shape that supersedes ADR-007's snake_case example block.
  - `[ADR-001](001-structured-logging-with-pino.md)` — the upstream Pino-configuration ADR ADR-007 explicitly does not supersede.

Do **not** rewrite the example JSON block or the `task-10 fills body` sentence in place. The supersession pointer + extended References redirect the reader to the current state without rewriting historical narrative — preserving ADR-003's immutability promise.

**Option B — Rewrite ADR-007's example block in place to use camelCase, and rewrite the `task-10 fills body` sentence to past tense.**

Mechanically simpler for future readers, but violates ADR-003's "Never edit a prior ADR in place beyond flipping its `Status` and adding a one-line supersession pointer" rule. Sets a precedent for in-place rewrites that erodes the immutability promise.

**Option C — Rewrite the log shape in `libs/observability/logger.module.ts` to emit snake_case `trace_id` / `span_id`, matching ADR-007.**

Rejected as the recommendation but listed for completeness. Would require touching every Pino enrichment site, every log-query playbook, ADR-015 (which would need to be superseded), and CLAUDE.md. The camelCase choice has been the load-bearing convention since task-10 shipped; reverting to snake_case is a disproportionate response to a wording discrepancy.

## Scope

**In:**

- Edit `docs/adr/007-pino-and-opentelemetry.md` Status line + add `## References` section (option A).

**Out:**

- Any change to `libs/observability/logger.module.ts` or `libs/observability/tracer.ts`.
- Any change to ADR-014 / ADR-015 (those already describe the correct state).
- Any change to CLAUDE.md (already correct).
- Any rewrite of ADR-007's `## Decision` body, example JSON, or `task-10 fills body` sentence.

## Exit criteria

- [ ] A reader landing on ADR-007 sees an explicit signal that the snake_case `trace_id` / `span_id` example is superseded by ADR-015, and that the OTLP / Jaeger wiring lives in ADR-014, with a forward-reference chain.
- [ ] No other ADR's text was edited beyond what the resolution requires.
- [ ] `yarn lint` still passes (touching only `docs/adr/*.md` should be a no-op for lint).
- [ ] `tmp/adr-verification-progress.md` ADR-007 row is updated to `HAS-CORRECTIONS` with a pointer back to this task.
