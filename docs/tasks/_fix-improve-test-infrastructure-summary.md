# fix — improve test infrastructure — summary

Resolves TEST-001 / TEST-002 / TEST-003 from
`docs/audits/audit-2026-05-20-followup.md`.

## Files edited

### New library files
- `libs/observability/testing/pino-logger.mock.ts` — `makePinoLoggerMock()` factory + `PinoLoggerMock` type alias. Replaces the inline `type LoggerMock = Record<...>` + `makeLogger()` factory previously duplicated across spec files.
- `libs/observability/testing/pino-memory-stream.ts` — `installMemoryPinoLogger()` helper + `E2E_PINO_DESTINATION_KEY` global-slot constant. Builds a `Writable` that captures each pino JSON-line record into an in-memory array, then registers it on `globalThis` under the documented key.
- `libs/observability/testing/index.ts` — barrel for the test-only helpers above. Intentionally **NOT** re-exported from `libs/observability/index.ts` so production import graphs never reach these files.

### Production-code changes
- `libs/observability/logger.module.ts` — reads `globalThis.__RIS_E2E_PINO_DESTINATION__`; when present, emits `pinoHttp` in the tuple form `[Options, DestinationStream]` and suppresses the pino-pretty transport (the two are mutually exclusive). The hook is inert in production / dev because the global is never set outside test bootstraps. The constant lives next to the LoggerModuleConfig to keep production code free of a `testing/` import; the test-side helper documents the same key string.
- `libs/observability/spec/logger.module.spec.ts` — narrowed the `pinoHttp.hooks` access through a localized cast, since the union now includes the tuple form.

### Tooling
- `tsconfig.json` — added deep-import path `@retail-inventory-system/observability/testing` (mirrors the existing `/tracer` deep-import convention).
- `jest.unit.config.js` and `jest.e2e.config.js` — added matching `moduleNameMapper` entries so ts-jest resolves the new path.
- `test/jest.setup.ts` — calls `installMemoryPinoLogger()` *before* the spec's imports run (Jest setup files are the only point at which the global hook can be installed before `LoggerModule.forRoot(new LoggerModuleConfig(...))` evaluates inside each AppModule's `@Module` decorator). Stashes `capturedLogs` on `globalThis.__RIS_E2E_CAPTURED_LOGS__` for any spec that wants log-based side-channel assertions.

### Specs refactored to use the shared mock (TEST-003)
- `apps/inventory-microservice/.../spec/get-stock.use-case.spec.ts`
- `apps/inventory-microservice/.../spec/reserve-stock-for-order.use-case.spec.ts`
- `apps/inventory-microservice/.../spec/add-stock.use-case.spec.ts`
- `apps/inventory-microservice/.../infrastructure/cache/spec/stock.cache.spec.ts`
- `apps/inventory-microservice/.../infrastructure/persistence/spec/stock-typeorm.repository.spec.ts` — *not* in the original task list, but the audit verification check (`grep -rn "type LoggerMock"`) requires it. Added as an obvious oversight in the task body, noted here for traceability.
- `apps/retail-microservice/.../spec/confirm-order.use-case.spec.ts`
- `apps/retail-microservice/.../spec/create-order.use-case.spec.ts`
- `apps/retail-microservice/.../spec/get-order.use-case.spec.ts`

### E2E spec changes (TEST-001 + TEST-002)
- `test/system-api.e2e-spec.ts` —
  - Removed `logger: false` from all three `NestFactory.create*` calls.
  - Reads `capturedLogs` from the global slot populated by `jest.setup.ts`.
  - `beforeEach` clears the array for per-test isolation.
  - Added explicit field assertions paired with every error-path `toMatchSnapshot()` (status code, error string, key message substrings).
  - For the two POST `/api/order` success paths and three PUT `/api/order/:id/confirm` data-row paths, added per-row-category assertions on header status, line counts, and `quantity === -1` sign on `productStockRows`.
  - Added one log-based side-channel assertion in the primed-cache GET test (`cacheHit: true` + msg substring) — proves the capture capability end-to-end alongside the existing sentinel-value pattern.

## Boundary rule changes (eslint.config.mjs)

None required. The boundaries config already excludes `**/spec/**`, `**/*.spec.ts`, and the `boundaries/dependencies` rule pattern only matches `apps/**/*.ts` and `libs/**/*.ts` against the production element graph. Spec/e2e files can freely import the `libs/observability/testing/` path without violating an architectural rule.

## Tests refactored vs added vs unchanged

| Category | Count | Notes |
| --- | --- | --- |
| Specs refactored to use `makePinoLoggerMock` | 8 | Seven listed in the task + the `stock-typeorm.repository.spec.ts` the verification check implicitly required |
| New e2e assertions (TEST-001) | ~18 | Field assertions paired with existing snapshots; snapshots unchanged |
| New e2e assertion (TEST-002) | 1 | `cacheHit: true` log assertion in the primed-cache GET test |
| Notification microservice's `FakeLogger` | unchanged | Per task instructions — deliberately different style for that service |

## Unit + e2e gate

| Gate | Result |
| --- | --- |
| `yarn install` | n/a (already installed) |
| `yarn build` | passes (4 webpack bundles, no warnings) |
| `yarn lint` (max-warnings 0) | passes |
| `yarn test:unit` | 174 / 174 across 29 suites |
| `yarn test:e2e` | 35 / 35 across 3 suites, 42 snapshots all green |
| `grep -rn "type LoggerMock" apps/*/src libs/*/src` | no matches |
| `grep -n "logger: false" test/system-api.e2e-spec.ts` | no matches |

## ADR

No ADR created. Rationale: the `globalThis` hook in `LoggerModuleConfig` is a narrow test-bootstrap seam, not a new architectural pattern — it doesn't change the production logger pipeline, doesn't introduce a new module boundary, and is documented inline at the source. The boundaries config wasn't touched. The test-only `libs/observability/testing/` directory is structurally identical to `libs/observability/tracer.ts`'s deep-import pattern, which itself is a documented carve-out without its own ADR.

## Documentation updates

- `CLAUDE.md` — no update needed. The `yarn test:e2e` interface is unchanged; the test-infra changes are invisible to the daily `Commands` reader. The shared `libs/observability/testing/` helper is implementation-internal — recorded here for traceability rather than in `CLAUDE.md`.
- `README.md` — no externally observable behavior change.

## Verification results

All mandatory checks green. Detailed table above.

## Anything unexpected — for human review

1. **Three iterations to wire the Pino memory stream correctly.** The two real bugs:
   - `pinoHttp({ ..., stream })` — silently dropped by pino-http; the stream must come through the 2nd positional arg or the nestjs-pino tuple form `pinoHttp: [Options, DestinationStream]`.
   - Installing the memory stream in `beforeAll` was already too late — `LoggerModule.forRoot(new LoggerModuleConfig(...))` is evaluated at AppModule *import time* by the `@Module` decorator. The install had to move into `test/jest.setup.ts` (which runs before any imports).

   Both are documented inline in `libs/observability/logger.module.ts`, `libs/observability/testing/pino-memory-stream.ts`, and `test/jest.setup.ts` so the next person modifying this seam has the context the audit follow-up lacked.

2. **`stock-typeorm.repository.spec.ts` was missing from the task's "files to refactor" list** but was caught by the verification check `grep -rn "type LoggerMock"`. I treated the verification check as authoritative and refactored the 8th file. Worth noting in the audit retrospective so the listing helper that produced the original audit can be refined.

3. **`msgPrefix` makes the captured `msg` field carry the `[<app>] ` prefix.** The cacheHit log assertion ended up using `expect.stringContaining('Cache hit for stock query')` rather than a literal match because the captured record's `msg` is `'[retail-microservice] Cache hit for stock query'`. Future log-based assertions in the same suite should follow the same convention.

4. **CI-only regression caught after local merge.** CI's `ci-cd.yml` sets `LOG_LEVEL: warn` at the job level so pipeline logs stay lean. `LoggerModuleConfig` originally honored `process.env.LOG_LEVEL` first, which on CI filtered the `debug`-level `cacheHit` log out before it could reach the memory stream — the spec saw an empty `capturedLogs` array. Fixed by making the e2e-capture branch unconditionally `'debug'`; documented inline in `libs/observability/logger.module.ts`. Verified locally by re-running the e2e suite with `LOG_LEVEL=warn` exported.

## Scope discipline — adjacent findings deferred

Per CONVENTIONS §6, the following duplicated patterns were observed across the seven specs but **not** fixed in this task:

- `const correlationId = 'corr-1'` repeated as a top-level constant in nearly every spec — candidate for a shared `test-fixtures/correlation.ts` helper.
- Identical `beforeEach(() => { jest.resetAllMocks(); ... })` setup blocks across the stock specs — candidate for a small `setupResettableMocks()` helper or a shared module-level `beforeEach`.
- The `as never` casts on `jest.Mocked<Pick<IPort, ...>>` are repeated 14+ times; a `mockOf<T, K>()` helper would centralize the pattern.

None of the above is a regression or a correctness issue — purely cosmetic / DRY opportunities for a future test-quality pass.
