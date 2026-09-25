import { IOccRetryLogger, IOccRetryPolicy, runWithOccRetry } from '../occ-retry';

class TestConflict extends Error {
  constructor(public readonly currentVersion: number) {
    super('conflict');
    this.name = 'TestConflict';
  }
}

class TerminalError extends Error {}

interface ILogLine {
  level: 'info' | 'warn';
  context: Record<string, unknown>;
  message: string;
}

const makeLogger = (): { logger: IOccRetryLogger; lines: ILogLine[] } => {
  const lines: ILogLine[] = [];
  return {
    lines,
    logger: {
      info: (context, message) => lines.push({ level: 'info', context, message }),
      warn: (context, message) => lines.push({ level: 'warn', context, message }),
    },
  };
};

const makePolicy = (
  logger: IOccRetryLogger,
  maxAttempts: number,
  overrides: Partial<IOccRetryPolicy<TestConflict>> = {},
): IOccRetryPolicy<TestConflict> => ({
  subject: 'Widget',
  logger,
  maxAttempts,
  isConflict: (error): error is TestConflict => error instanceof TestConflict,
  retryContext: (conflict) => ({ widgetId: 7, currentVersion: conflict.currentVersion }),
  exhaustedContext: () => ({ widgetId: 7 }),
  onExhausted: (conflict, attempts): never => {
    throw new TerminalError(`exhausted after ${attempts} @ v${conflict.currentVersion}`);
  },
  ...overrides,
});

describe('runWithOccRetry (ADR-036 protocol)', () => {
  it('returns the first successful attempt without logging anything', async () => {
    const { logger, lines } = makeLogger();
    const attempt = jest.fn().mockResolvedValue('ok');

    await expect(runWithOccRetry(attempt, makePolicy(logger, 5))).resolves.toBe('ok');

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });

  it('retries a conflict and returns the attempt that finally wins', async () => {
    const { logger, lines } = makeLogger();
    const attempt = jest
      .fn()
      .mockRejectedValueOnce(new TestConflict(3))
      .mockRejectedValueOnce(new TestConflict(4))
      .mockResolvedValue('ok');

    await expect(runWithOccRetry(attempt, makePolicy(logger, 5))).resolves.toBe('ok');

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(lines.map((line) => line.level)).toEqual(['info', 'info']);
  });

  it('NEVER retries a non-conflict — a domain rejection is terminal', async () => {
    const { logger, lines } = makeLogger();
    const attempt = jest.fn().mockRejectedValue(new TerminalError('OUT_OF_STOCK'));

    await expect(runWithOccRetry(attempt, makePolicy(logger, 5))).rejects.toThrow('OUT_OF_STOCK');

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(lines).toEqual([]);
  });

  it('bounds the attempts by maxAttempts, then calls onExhausted', async () => {
    const { logger } = makeLogger();
    const attempt = jest.fn().mockRejectedValue(new TestConflict(9));

    await expect(runWithOccRetry(attempt, makePolicy(logger, 3))).rejects.toThrow(
      'exhausted after 3 @ v9',
    );

    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('honours maxAttempts = 1 — no retry at all (the If-Match path)', async () => {
    const { logger, lines } = makeLogger();
    const attempt = jest.fn().mockRejectedValue(new TestConflict(1));

    await expect(runWithOccRetry(attempt, makePolicy(logger, 1))).rejects.toThrow(TerminalError);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(lines.map((line) => line.level)).toEqual(['warn']);
  });

  it('logs retries at info and exhaustion at warn, with the fixed message texts', async () => {
    const { logger, lines } = makeLogger();
    const attempt = jest.fn().mockRejectedValue(new TestConflict(11));

    await expect(runWithOccRetry(attempt, makePolicy(logger, 2))).rejects.toThrow(TerminalError);

    expect(lines).toEqual([
      {
        level: 'info',
        context: { widgetId: 7, currentVersion: 11, attempt: 1, maxAttempts: 2 },
        message: 'Widget write conflict — retrying with a fresh read',
      },
      {
        level: 'warn',
        context: { widgetId: 7, attempts: 2, maxAttempts: 2 },
        message: 'Widget write conflict exhausted retry budget',
      },
    ]);
  });

  it('surfaces a policy that forgets to throw, rather than returning undefined as success', async () => {
    const { logger } = makeLogger();
    const attempt = jest.fn().mockRejectedValue(new TestConflict(2));
    const policy = makePolicy(logger, 2, {
      onExhausted: (() => undefined) as unknown as IOccRetryPolicy<TestConflict>['onExhausted'],
    });

    await expect(runWithOccRetry(attempt, policy)).rejects.toThrow(
      'runWithOccRetry: optimistic retry loop exited unexpectedly',
    );
  });
});
