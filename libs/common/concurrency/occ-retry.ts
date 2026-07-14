// The bounded optimistic-concurrency retry protocol (ADR-036), in one place (ADR-045).
//
// The invariant core lives here and is not negotiable per module: the loop, the bounded budget,
// the log levels, the two message texts, and the rule that **only a lost compare-and-swap
// retries**. Everything a module genuinely owns arrives as a closure — its conflict type, its
// terminal `*DomainException`, the fields it puts on the trace — because a lib cannot know that
// a lost stock CAS identifies its row by `(variantId, stockLocationId)` while a cart identifies
// its by `cartId`.

// A structural logger, NOT `PinoLogger`. `libs/common` is framework-free, and importing
// `nestjs-pino` to write two lines would end that (the `boundaries` rules reject it).
// `PinoLogger` satisfies this shape structurally, so every caller passes its own logger
// unchanged.
export interface IOccRetryLogger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
}

export interface IOccRetryPolicy<TConflict> {
  // The subject of the two log lines — `Cart`, `Order`, `Return request`, `Stock`. It is the
  // ONLY part of the message text a module chooses; the rest is fixed here, which is what
  // makes the trace greppable across services.
  subject: string;

  logger: IOccRetryLogger;

  // The bounded budget, injected from `OCC_RETRY_ATTEMPTS` — never a constant. Pass `1` to
  // disable retrying, which is what a client-pinned `If-Match` version requires: a lost race
  // must surface as a conflict rather than silently resolve to a different outcome than the one
  // the caller pinned.
  maxAttempts: number;

  // Narrows the caught error to THIS module's conflict type. A type guard rather than a base
  // class on purpose: a base class would let one module's loop silently retry another's
  // conflict, and the whole rule here is that only the write we made can be retried.
  isConflict: (error: unknown) => error is TConflict;

  // Extra fields for the two traces. Separate hooks because they genuinely differ — inventory
  // logs the losing row's identity from the CONFLICT on retry (a multi-row write's loser is
  // more precise than the caller's context) but from the caller's context on exhaustion.
  retryContext: (conflict: TConflict) => Record<string, unknown>;
  exhaustedContext: (conflict: TConflict) => Record<string, unknown>;

  // Throws the module's terminal `*DomainException`. The `never` return type makes throwing a
  // compile-time obligation: a policy that forgot to throw would otherwise fall through the
  // loop and return `undefined` as if the write had succeeded.
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
      // Anything that is not a lost CAS propagates immediately and is NEVER retried. A domain
      // rejection (`OUT_OF_STOCK`, `ORDER_NOT_CANCELLABLE`, a stale `If-Match`) is a state the
      // request genuinely forbids — retrying it would just burn the budget and return the same
      // refusal, or worse, resolve to a different outcome than the caller asked for.
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

      // `info`, not `debug` (ADR-036): a lost compare-and-swap is a NORMAL outcome under
      // contention, not a defect. `test/concurrent-sweep-release.e2e-spec.ts` asserts this
      // trace fires with its attempt count and row identity — the levels and both message
      // texts are pinned there.
      logger.info(
        { ...retryContext(error), attempt: attemptNo, maxAttempts },
        `${subject} write conflict — retrying with a fresh read`,
      );
    }
  }

  // Unreachable: the final attempt either returns, rethrows, or `onExhausted` throws.
  throw new Error('runWithOccRetry: optimistic retry loop exited unexpectedly');
}
