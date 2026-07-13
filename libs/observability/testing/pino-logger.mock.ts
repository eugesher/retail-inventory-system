// Shared mock for nestjs-pino's `PinoLogger`. Hoisted out of seven spec
// files that previously redefined the same `LoggerMock` type alias and
// `makeLogger()` factory inline (TEST-003 in audit-2026-05-20-followup).
//
// Production code never reaches this file: it lives under `libs/observability/testing/`
// and is intentionally NOT re-exported from `libs/observability/index.ts`.
// Specs and e2e tests reach it via the deep-import path
// `@retail-inventory-system/observability/testing`.

// `assign` belongs here beside the six level methods, and its absence was not free: it is how a
// REQUEST-SCOPED logger binds `correlationId` onto every subsequent line, and every RPC-fronting use
// case in the gateway opens with `this.logger.assign({ correlationId })`. A double without it does not
// fail an assertion — it throws `this.logger.assign is not a function` on the first line of the method
// under test, so the use case cannot be unit-tested at all. That is a plausible reason the gateway's
// use cases had no unit specs and were reached only through e2e.
//
// (It is a no-op in the double, which is right: `assign` mutates the logger's bound context, and a spec
// asserts on what was LOGGED, not on the binding. The one place `assign` must never be called is an
// `@EventPattern` handler — those are not request-scoped and it throws there in production too, ADR-011
// §7 — and a spec for such a handler simply never reaches this method.)
export type PinoLoggerMock = Record<
  'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace' | 'assign',
  jest.Mock
>;

export const makePinoLoggerMock = (): PinoLoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
  assign: jest.fn(),
});
