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
