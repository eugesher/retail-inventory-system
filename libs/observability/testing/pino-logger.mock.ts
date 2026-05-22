// Shared mock for nestjs-pino's `PinoLogger`. Hoisted out of seven spec
// files that previously redefined the same `LoggerMock` type alias and
// `makeLogger()` factory inline (TEST-003 in audit-2026-05-20-followup).
//
// Production code never reaches this file: it lives under `libs/observability/testing/`
// and is intentionally NOT re-exported from `libs/observability/index.ts`.
// Specs and e2e tests reach it via the deep-import path
// `@retail-inventory-system/observability/testing`.

export type PinoLoggerMock = Record<
  'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace',
  jest.Mock
>;

export const makePinoLoggerMock = (): PinoLoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});
