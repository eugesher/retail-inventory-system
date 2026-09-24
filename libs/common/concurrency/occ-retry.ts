export interface IOccRetryLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface IOccRetryPolicy<TConflict> {
  subject: string;

  logger: IOccRetryLogger;

  maxAttempts: number;

  isConflict: (error: unknown) => error is TConflict;

  retryContext: (conflict: TConflict) => Record<string, unknown>;
  exhaustedContext: (conflict: TConflict) => Record<string, unknown>;

  onExhausted: (conflict: TConflict, attempts: number) => never;
}

export async function runWithOccRetry<T, TConflict>(
  attempt: () => Promise<T>,
  policy: IOccRetryPolicy<TConflict>,
): Promise<T> {
  const { subject, logger, maxAttempts, isConflict, retryContext, exhaustedContext, onExhausted } =
    policy;

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    try {
      return await attempt();
    } catch (error) {
      if (!isConflict(error)) {
        throw error;
      }

      if (attemptNo >= maxAttempts) {
        logger.warn(
          { ...exhaustedContext(error), attempts: attemptNo, maxAttempts },
          `${subject} write conflict exhausted retry budget`,
        );
        onExhausted(error, attemptNo);
      }

      logger.info(
        { ...retryContext(error), attempt: attemptNo, maxAttempts },
        `${subject} write conflict — retrying with a fresh read`,
      );
    }
  }

  throw new Error('runWithOccRetry: optimistic retry loop exited unexpectedly');
}
