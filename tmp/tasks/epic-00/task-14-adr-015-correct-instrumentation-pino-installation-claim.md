---
epic: epic-00
task_number: 14
title: Correct ADR-015's `@opentelemetry/instrumentation-pino` "not installed" claim — the package ships transitively via `auto-instrumentations-node` and is active at runtime
depends_on: []
doc_deliverable: null
---

# Task 14 — Correct ADR-015's "auto-instrumentation package is not installed" narrative

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** Open ADR-015 in full, then ADR-014 (the OTel SDK bootstrap that registers `getNodeAutoInstrumentations()` — which is where `instrumentation-pino` activates), ADR-007 (the parent decision committing to OTel + Pino), and ADR-003 (ADR immutability rule). The live `libs/observability/tracer.ts` is the side-effect bootstrap; the `yarn.lock` is the source of truth for what's actually resolved into `node_modules`.

## ADR audited

[ADR-015 — Pino log lines carry OTel `traceId` / `spanId`](../../../docs/adr/015-pino-trace-correlation.md). Accepted (2026-05-14).

## Discrepancy

ADR-015 §"Field naming" closes with:

> If the project later opts into `@opentelemetry/instrumentation-pino` (which auto-injects `trace_id`/`span_id` without our hook), this hook becomes redundant and is removed. Today the auto-instrumentation package is not installed.

The final sentence is **dated**. `@opentelemetry/instrumentation-pino@0.64.0` IS in `yarn.lock` — pulled transitively by `@opentelemetry/auto-instrumentations-node@^0.76.0` (which `package.json` lists as a direct dependency). `getNodeAutoInstrumentations()` in `libs/observability/tracer.ts:48` enables every bundled instrumentation by default, so `instrumentation-pino` activates at SDK start, patches Pino when `nestjs-pino` requires it later in the boot, and begins injecting `trace_id` / `span_id` (snake_case) into every Pino record from inside an active span.

The hook is **not** redundant despite the package being active — the hook is the only reason `traceId` / `spanId` (the camelCase pair the rest of the project's logs use) appears alongside the snake_case pair. ADR-015 §"Field naming" already explicitly anticipates this coexistence:

> Auto-instrumentations that decorate logs themselves (e.g. when `instrumentation-pino` is added later) emit `trace_id` / `span_id`. Having both shapes co-exist on the same line is acceptable — operators can grep either; OTel-aware sinks understand the snake_case pair without configuration.

The coexistence the ADR labels "later" is in fact happening **today**.

This is **CODE-DISCREPANCY (stale narrative)**, not a binding-rule break. ADR-015's binding decisions — camelCase `traceId` / `spanId`, the `logMethod` hook as the seam, `correlationId` retained alongside, no `traceparent` response header — all still hold and are verified in the live code. The drift is the *installation-status footnote*.

Surface: `docs/adr/015-pino-trace-correlation.md` (the ADR prose itself).

## Evidence

ADR-015 §"Field naming" (`docs/adr/015-pino-trace-correlation.md:73-76`):

```text
If the project later opts into `@opentelemetry/instrumentation-pino`
(which auto-injects `trace_id`/`span_id` without our hook), this hook
becomes redundant and is removed. Today the auto-instrumentation
package is not installed.
```

`package.json` carries the bundle that pulls `instrumentation-pino` transitively:

```text
package.json:    "@opentelemetry/auto-instrumentations-node": "^0.76.0",
```

`yarn.lock` confirms the transitive resolve:

```text
yarn.lock:    "@opentelemetry/instrumentation-pino": "npm:^0.64.0"
yarn.lock:"@opentelemetry/instrumentation-pino@npm:^0.64.0":
yarn.lock:  resolution: "@opentelemetry/instrumentation-pino@npm:0.64.0"
```

The SDK bootstrap activates the bundle (`libs/observability/tracer.ts:46-49`):

```ts
const sdk = new NodeSDK({
  resource,
  traceExporter,
  instrumentations: [getNodeAutoInstrumentations()],
});
```

`getNodeAutoInstrumentations()` enables every bundled instrumentation by default — including `instrumentation-pino` — unless explicitly disabled via the function's options argument. The repo passes no options, so the bundle's default-on behaviour applies.

The custom hook stays correct and useful regardless (`libs/observability/logger.module.ts:75-86`):

```ts
const spanContext = trace.getActiveSpan()?.spanContext();
if (spanContext?.traceId && spanContext.spanId) {
  const first = inputArgs[0];
  const enrichment = { traceId: spanContext.traceId, spanId: spanContext.spanId };

  if (typeof first === 'object' && first !== null) {
    inputArgs[0] = { ...enrichment, ...(first as Record<string, unknown>) };
  } else {
    inputArgs.unshift(enrichment);
  }
}
```

The camelCase pair is the one the rest of the codebase greps for (verified by `grep -rn "traceId" apps/` returning real production lines; no live code references `trace_id`). The hook is therefore **not** redundant — removing it would drop the camelCase pair operators are trained on.

## Why this matters

ADR-015 is the ADR a future implementer reads when they need to understand the trace-log correlation seam. The dated footnote can mislead in two ways:

1. **A future "let's simplify by removing the hook" attempt.** A reader who follows the footnote literally will see that `instrumentation-pino` is "not installed", conclude that's the only thing keeping the hook necessary, install the package directly (or notice it's already transitive), and then delete the hook — losing the camelCase `traceId` / `spanId` field every log query in the codebase expects. The deletion will pass `yarn lint` and `yarn test:unit` because the spec at `libs/observability/spec/logger.module.spec.ts` is a *unit* test of the hook, not an integration test of the live shape; but production logs lose the camelCase pair.
2. **Debugging a "where do `trace_id` / `span_id` come from?" question.** An operator who notices snake_case fields in real logs and reads ADR-015 will see the "not installed today" sentence and search for where they're coming from. The path (auto-instrumentations-node → instrumentation-pino → pino require) is non-obvious; the ADR not flagging it makes the search longer.

The same supersession-pointer / amend pattern is filed for the other ADRs whose narrative has drifted (ADR-001 epic-00/task-01, ADR-002 epic-00/task-02, ADR-006 epic-00/task-05, ADR-007 epic-00/task-06, ADR-008 epic-00/task-07, ADR-004 epic-00/task-04, ADR-012 epic-00/task-12, ADR-013 epic-00/task-13). ADR-015 follows the same shape.

## Proposed resolution

Two options. Recommend **option A**.

**Option A — Amend ADR-015's `**Status**` line + add a one-bullet clarification (recommended).**

ADR-015 has no `## References` section today, but the simpler edit is a `**Status**`-line pointer plus a one-bullet note appended after the §"Field naming" block (or as a new short `## References` section at the bottom). Concrete edits:

- Replace `**Status**: Accepted` (line 4) with `**Status**: Accepted (the "not installed today" sentence in §"Field naming" is dated; see References)`.
- Add a `## References` section at the bottom of the file:

  ```markdown
  ## References

  - **§"Field naming" — "Today the auto-instrumentation package is not
    installed".** Dated. `@opentelemetry/instrumentation-pino@0.64.0`
    is in `yarn.lock`, pulled transitively by
    `@opentelemetry/auto-instrumentations-node@^0.76.0`
    (a direct dependency in `package.json`).
    `libs/observability/tracer.ts` activates the full
    `getNodeAutoInstrumentations()` bundle without disabling any
    member, so `instrumentation-pino` patches Pino at boot and
    injects snake_case `trace_id` / `span_id` onto every record
    inside an active span. The custom `logMethod` hook in
    `libs/observability/logger.module.ts` is **not** redundant — it
    is the only source of the camelCase `traceId` / `spanId` pair
    the rest of the codebase greps for, and the §"Field naming"
    coexistence trade-off the ADR anticipates is already in
    production logs.
  - [ADR-014](014-otel-exporter-otlp-http-and-jaeger.md) — the SDK
    bootstrap that registers the auto-instrumentations bundle.
  - [ADR-007](007-pino-and-opentelemetry.md) — the parent decision
    committing to Pino + OTel; `epic-00/task-06` already amends its
    example log shape from snake_case to camelCase.
  ```

Do **not** rewrite §"Field naming" in place. The Nygard immutability rule of ADR-003 keeps the historical decision text intact; the `## References` section is the forward graph for a reader to follow.

**Option B — Rewrite the closing sentence of §"Field naming" in place ("Today the auto-instrumentation package is …").**

Mechanically simpler but violates ADR-003's immutability rule. Sets a precedent that erodes trust in the ADR set. Rejected as the recommendation.

If option B is chosen anyway, the rewrite must (a) preserve the rationale paragraph (the camelCase choice was correct and the coexistence trade-off was anticipated), (b) replace only the installation-status sentence with the runtime-truth statement, and (c) carry an inline footnote linking forward to this task / `yarn.lock`.

## Scope

**In:**

- Edit `docs/adr/015-pino-trace-correlation.md`:
  - Flip the `**Status**` line per option A.
  - Append a `## References` section at the bottom of the file with the three bullets above (or, per option B, rewrite the closing sentence of §"Field naming" with an inline footnote).

**Out:**

- Any change to live code under `libs/observability/` or `package.json`. The hook stays.
- Any change to ADR-014 / ADR-007 (parent / sibling ADRs that are not the audited surface; ADR-007's snake-case example shape is already filed under `epic-00/task-06`).
- Any change to the `getNodeAutoInstrumentations()` call site or to the bundle's instrumentation set — disabling `instrumentation-pino` (if ever desired) is a separate technical decision that needs its own ADR or design discussion.
- Any change to CLAUDE.md.

## Exit criteria

- [ ] `docs/adr/015-pino-trace-correlation.md`'s `**Status**` line carries the forward-clarification pointer (or follows option B with an inline footnote).
- [ ] `docs/adr/015-pino-trace-correlation.md` ends with a `## References` section that names `instrumentation-pino` as transitively-installed-and-active (option A) — or §"Field naming" is rewritten in place with the inline footnote (option B).
- [ ] `grep -n "auto-instrumentations-node\\|instrumentation-pino" docs/adr/015-pino-trace-correlation.md` returns at least one match (proves the clarification landed).
- [ ] `yarn lint` still passes (this task edits only `docs/adr/*.md`).
- [ ] `tmp/adr-verification-progress.md` ADR-015 row reflects this task's findings.
