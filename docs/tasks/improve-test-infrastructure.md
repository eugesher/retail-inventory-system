# fix — explicit assertions, e2e Pino capture, and `makePinoLoggerMock` helper

> Paste this entire file as the first user message in a Claude Code (Opus)
> session opened at the project root of `retail-inventory-system`. Do not
> add anything else.

## Conventions

This task inherits the rules in
[`docs/tasks/CONVENTIONS.md`](CONVENTIONS.md). Read it before starting.

## Context

- Source audit: [`docs/audits/audit-2026-05-20-followup.md`](../audits/audit-2026-05-20-followup.md)
- Issues addressed: **TEST-001**, **TEST-002**, **TEST-003**
- Original audit (historical): [`docs/audits/audit-2026-05-08.md`](../audits/audit-2026-05-08.md)

Three test-infrastructure refinements that the original audit grouped
as "other" because they don't change product behavior:

**TEST-001 — snapshot-only assertions mask regression source.** In
`test/system-api.e2e-spec.ts`, several assertions rely on
`toMatchSnapshot()` alone. Examples: the 400-error bodies (L218, L226,
L289, L309), the `assertData` helper for confirm-order (L390–L402)
that snapshots three rows-of-interest with no explicit field assertions.
When a snapshot diff fires after a code change, the failure surface
spans cache, DB, and DTO shape collapsed into one signal. Pairing
snapshots with explicit assertions on the critical fields (status code,
order id mapping, product stock quantity sign, error code) makes
regressions attributable.

**TEST-002 — Pino logger disabled in E2E.** `test/system-api.e2e-spec.ts`
L52, L67, L77 bootstrap all three apps with `logger: false`, which
silences the `cacheHit` log field that `StockCache.get` / `set` emit.
That field is a clean side-channel for cache assertions; today the
e2e suite has to reach into the cache directly via `getCachedStock` /
`setCachedStock` (L38–L44). Enabling the logger and piping Pino into
a memory transport would unlock log-based assertions and reduce
test-state-mutation through direct cache reads.

**TEST-003 — `makePinoLoggerMock()` factory.** Every spec that mocks
`PinoLogger` redefines the same `LoggerMock` type alias and `makeLogger()`
factory inline:
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/get-stock.use-case.spec.ts` L9–L18
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/reserve-stock-for-order.use-case.spec.ts` L17–L26
- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/add-stock.use-case.spec.ts`
- `apps/inventory-microservice/src/modules/stock/infrastructure/cache/spec/stock.cache.spec.ts` L27–L36
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/confirm-order.use-case.spec.ts` L17–L26
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/create-order.use-case.spec.ts`
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/get-order.use-case.spec.ts`
- (the notification specs use a different class-based `FakeLogger` — see
  caveat below; leave them alone)

Hoisting the inline factory into a shared helper removes ~50 lines of
duplication and centralizes the mock shape if `PinoLogger`'s surface
grows.

Why bundle them: all three are test-infra refinements and would touch
the same handful of files / helpers. Shipping them together is one
review cycle rather than three.

## Goal

- Critical-field assertions sit next to snapshot calls in the e2e
  spec, making snapshot diffs attributable.
- The e2e bootstrap enables Pino against a memory transport so log
  assertions are possible (whether or not this task adds the first
  log assertion — the *capability* is the deliverable).
- A `makePinoLoggerMock()` helper lives in a shared test-util location
  and is used by every spec that previously had the inline factory.
  The notification microservice's `FakeLogger` class is **kept** —
  it's a deliberately different style for that service's no-RPC
  shape (see DOCS-001 follow-up note).

## Acceptance criteria

- [ ] Every `toMatchSnapshot()` call in `test/system-api.e2e-spec.ts`
      that asserts an error-path body is **paired with** an explicit
      assertion on at least the status code and the error code/message
      field. (Status code is already asserted separately in most cases
      — the missing piece is an explicit field assertion on the body.)
- [ ] The `assertData` helper used by the order-confirm tests
      (`system-api.e2e-spec.ts` L390–L402) asserts explicitly on at
      least one critical field per row category (e.g. `orderRows[0].statusId`,
      `productStockRows.length`, `productStockRows[0].quantity` sign).
      Snapshots stay as the comprehensive baseline.
- [ ] `test/system-api.e2e-spec.ts` no longer passes `logger: false`
      to any of the three `NestFactory.create*` calls. A memory-backed
      Pino transport is installed (e.g. via a custom stream collected
      into an array) and exposed to the test as `capturedLogs: Array<{...}>`
      or similar.
- [ ] At least one e2e test uses the captured logs as a side-channel
      assertion (e.g. asserts a `cacheHit: true` log line is present
      after a primed-cache GET) — the *capability* is unlocked, not
      just installed.
- [ ] A shared `makePinoLoggerMock()` factory lives at
      `libs/observability/testing/pino-logger.mock.ts` (or a similar
      path under `libs/observability` — see step 2). It returns
      `Record<'debug'|'info'|'warn'|'error'|'fatal'|'trace', jest.Mock>`
      and is exported from `libs/observability/index.ts` (or a sub-path
      that respects the architecture-lint boundaries — see ADR-017).
- [ ] Every inline `LoggerMock` / `makeLogger()` definition in the
      seven specs listed under TEST-003 above is replaced with an
      import of the shared helper.
- [ ] The notification microservice's `FakeLogger` class is **untouched**.
- [ ] `yarn test:unit` and `yarn test:e2e` both pass after the change.

## Files likely involved

- `test/system-api.e2e-spec.ts` — Pino capture wiring; pair snapshots
  with explicit field assertions.
- `libs/observability/` — new `testing/pino-logger.mock.ts` (path may
  need to be different to satisfy boundaries — see step 2). New
  `testing/pino-memory-stream.ts` if you decide to ship the e2e Pino
  capture helper as a library export rather than inline in the spec.
- Seven spec files under `apps/inventory-microservice/` and
  `apps/retail-microservice/` (listed under TEST-003 in the audit
  follow-up).
- `eslint.config.mjs` — verify the new test-util path is allowed in
  spec files. ADR-017's boundaries config may need a narrow exception
  to let `libs/observability/testing/*` be imported from `apps/*/src/**/spec/*.spec.ts`
  and `test/*.e2e-spec.ts` without polluting the production import
  graph.

## Steps

1. **TEST-001 first** (smallest scope). In `test/system-api.e2e-spec.ts`,
   walk each `toMatchSnapshot()` call. For error paths, add an explicit
   `expect(body.errorCode).toBe(...)` or `expect(body.statusCode).toBe(400)`
   alongside the snapshot. For `assertData` (L390–L402), add explicit
   assertions on:
   - `expect(orderRows[0].statusId).toBe(OrderStatusEnum.CONFIRMED)` (or
     whatever the test's contract is — vary per `it` block);
   - `expect(productStockRows.length).toBeGreaterThan(0)`;
   - `expect(productStockRows.every(r => r.quantity === -1)).toBe(true)`
     (or similar sign assertion).
   Keep all existing snapshots — explicit assertions are *additive*.

2. **TEST-003 next** (mechanical refactor). Decide where the helper lives.
   The cleanest option is `libs/observability/testing/pino-logger.mock.ts`
   so the helper is co-located with the `PinoLogger` it mocks. But
   `libs/observability` may not currently export anything to specs;
   check `eslint.config.mjs` for a boundaries rule that allows
   `libs/observability/testing/*` imports from `apps/*/**/spec/*` and
   `test/*`. If no such rule exists, add one (narrow — only `testing/*`
   files, only from `*.spec.ts` and `*.e2e-spec.ts`).
   
   The helper signature:
   ```ts
   export type PinoLoggerMock = Record<
     'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace',
     jest.Mock
   >;
   export const makePinoLoggerMock = (): PinoLoggerMock => ({
     debug: jest.fn(), info: jest.fn(), warn: jest.fn(),
     error: jest.fn(), fatal: jest.fn(), trace: jest.fn(),
   });
   ```
   Update the seven specs to import + use the helper. Drop their
   inline `LoggerMock` type alias and `makeLogger()` factory.

3. **TEST-002 last** (biggest design surface). Pick a capture
   strategy:
   - **Inline in the spec.** Easiest. Build a `pino` instance pointed
     at a memory stream that pushes onto a `capturedLogs: any[]` array,
     pass it via the Nest bootstrap. The downside is the spec gets
     bigger.
   - **Library helper.** Add
     `libs/observability/testing/pino-memory-stream.ts` exporting a
     `createMemoryPinoLogger()` that returns `{ logger, capturedLogs }`.
     Cleaner; reusable for future e2e tests. Recommended.

   Wire it into the e2e spec's three `NestFactory.create*` calls in
   place of `logger: false`. Note: the API gateway and microservices
   use nestjs-pino, not the raw Nest logger — the wiring may need
   to register a `LoggerModule.forRoot(...)` with the memory pino in
   the AppModule, or use Nest's `app.useLogger(...)` after creation.
   The simplest path is `app.useLogger(...)` because it doesn't
   require re-importing the AppModule with override providers.

   Add **one** new e2e assertion that exercises the capability — the
   primed-cache GET test (L191–L209) already proves cache-hit behavior
   via the sentinel pattern; this task adds the parallel log assertion
   (`expect(capturedLogs).toContainEqual(expect.objectContaining({ cacheHit: true }))`)
   alongside. The point is to prove the capture works end-to-end, not
   to retire the sentinel pattern.

4. Run the verification gate. The e2e suite is gated behind
   `yarn test:infra:reload` — slow. Plan for the full run.

## Documentation updates required

- [ ] No ADR required for TEST-001 / TEST-003 — pure test-infra,
      no architectural decision.
- [ ] TEST-002 may warrant a tiny ADR if you add a new
      `libs/observability/testing/` boundary rule — that's a real
      change to ADR-017's surface. If you do, document the rule and
      its scope (specs and e2e only).
- [ ] Update `CLAUDE.md` "Commands → Testing" section if the e2e
      bootstrap behavior change affects how tests should be invoked
      (it shouldn't — the `yarn test:e2e` interface is unchanged).
      Verify and record "no CLAUDE.md update required" if so.
- [ ] No `README.md` update required.

## Verification

- [ ] `yarn install` succeeds
- [ ] `yarn build` succeeds
- [ ] `yarn lint` succeeds (max-warnings 0) — pay attention to
      boundaries violations on the new test-util import path
- [ ] `yarn test:unit` succeeds (all seven specs still pass with
      the shared helper)
- [ ] `yarn test:e2e` succeeds (all e2e tests pass; the new
      `cacheHit: true` log assertion fires under the primed-cache
      GET test)
- [ ] `grep -rn "type LoggerMock" apps/*/src libs/*/src` returns
      no matches in spec files — duplication is gone
- [ ] `grep -n "logger: false" test/system-api.e2e-spec.ts` returns
      no matches

## Carryover

Write `_fix-improve-test-infrastructure-summary.md` with:

- Files edited (paths + one-line summary)
- New library files (`pino-logger.mock.ts`, optionally
  `pino-memory-stream.ts`)
- Boundary rule changes (eslint.config.mjs, with the new pattern)
- Tests refactored vs added vs unchanged
- ADR created (if any) or "no ADR needed" with reason
- Documentation updates
- Verification results
- Anything unexpected — surface for human review

## Scope discipline

Per CONVENTIONS §6: while editing the seven specs, you will likely
notice other duplicated patterns (e.g. `correlationId = 'corr-1'` as
a top-level const; identical `beforeEach` blocks). **Do not refactor
those in this task.** Record any such finding in the carryover for a
future cleanup pass.
