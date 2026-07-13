import { IOccRetryLogger, IOccRetryPolicy, runWithOccRetry } from '../occ-retry';

// The bounded OCC retry protocol (ADR-036), tested in isolation for the first time (ADR-045).
//
// This is the point of lifting the loop out of the four modules. Before, the protocol existed
// as four hand-copied loops, and every rule it encodes — the levels, the message texts, "only a
// lost CAS retries", the budget bound, "exhaustion must throw" — was only ever exercised
// incidentally, through whichever use-case spec happened to drive a conflict. None of them
// asserted the rules themselves.
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
    // A write that wins its race is not an event. Logging here would put a line on every
    // successful mutation in the system.
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

    // The single most important rule in the protocol. Retrying a state the request genuinely
    // forbids would burn the budget to return the same refusal — or worse, resolve to a
    // different outcome than the caller asked for.
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

    // Exactly the budget — not budget+1 (an off-by-one here would double the load a hot row
    // sees under contention).
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('honours maxAttempts = 1 — no retry at all (the If-Match path)', async () => {
    const { logger, lines } = makeLogger();
    const attempt = jest.fn().mockRejectedValue(new TestConflict(1));

    await expect(runWithOccRetry(attempt, makePolicy(logger, 1))).rejects.toThrow(TerminalError);

    expect(attempt).toHaveBeenCalledTimes(1);
    // Straight to exhaustion: a client that pinned a version must be told its view is stale,
    // not silently retried into a different outcome.
    expect(lines.map((line) => line.level)).toEqual(['warn']);
  });

  it('logs retries at info and exhaustion at warn, with the fixed message texts', async () => {
    const { logger, lines } = makeLogger();
    const attempt = jest.fn().mockRejectedValue(new TestConflict(11));

    await expect(runWithOccRetry(attempt, makePolicy(logger, 2))).rejects.toThrow(TerminalError);

    // ADR-036 pins the levels: a lost CAS is a NORMAL outcome under contention, so it is `info`
    // — not `warn` (which would cry wolf on every contended write) and not `debug` (which would
    // hide it in production). Exhaustion is the abnormal one.
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
    // TypeScript's `never` return type makes this un-writable in real code; the cast proves the
    // runtime guard behind it. A silent fall-through would report a LOST write as a successful
    // one — the worst possible failure for this loop.
    const policy = makePolicy(logger, 2, {
      onExhausted: (() => undefined) as unknown as IOccRetryPolicy<TestConflict>['onExhausted'],
    });

    await expect(runWithOccRetry(attempt, policy)).rejects.toThrow(
      'runWithOccRetry: optimistic retry loop exited unexpectedly',
    );
  });
});
