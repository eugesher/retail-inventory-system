import { PinoLogger } from 'nestjs-pino';

export interface IRetryThenLogForReplayOptions {
  // Bounded attempt budget — retries are immediate (no backoff), the realistic failure
  // being a transient RMQ hiccup the broker recovers from; a backoff is a later
  // refinement that would live here, in the one place the posture is defined.
  maxAttempts: number;
  logger: PinoLogger;
  correlationId: string;
  // Short operation label for the per-attempt warn, e.g. 'Restock-from-Return' (the
  // message is `${label} failed — retrying`).
  label: string;
  // Identifying fields logged on every retry warn and on the final poison-record error
  // (the full payload an operator needs to replay the operation).
  context: Record<string, unknown>;
  // The terminal error message — the post-commit posture differs per caller, so each
  // spells out what awaiting-replay means (the restock replay is idempotent on
  // `returnRequestId`).
  replayMessage: string;
}

// Runs a post-commit cross-service `operation`, retrying up to `maxAttempts`. On a
// persistent failure it logs the full `context` at `error` (a poison record for operator
// replay) and returns **WITHOUT throwing**: the local transaction has already committed
// and must not be rolled back (the post-commit eventual-consistency posture, ADR-031/032).
// A failed restock leaves the goods un-credited until a manual replay runs it — it never
// corrupts the counters (the restock is idempotent on `returnRequestId` inventory-side).
//
// This is a deliberate local copy of the orders module's `retry-then-log-for-replay`
// helper: the returns bounded context cannot import the orders module (the boundaries
// lint, ADR-017), so the one-place-per-module posture is duplicated rather than shared
// across the isolation line (the cost of the bounded-context split, ADR-032).
export async function retryThenLogForReplay(
  operation: () => Promise<unknown>,
  options: IRetryThenLogForReplayOptions,
): Promise<void> {
  const { maxAttempts, logger, correlationId, label, context, replayMessage } = options;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await operation();
      return;
    } catch (error) {
      if (attempt < maxAttempts) {
        logger.warn(
          { err: error as Error, correlationId, attempt, ...context },
          `${label} failed — retrying`,
        );
        continue;
      }
      logger.error({ err: error as Error, correlationId, ...context }, replayMessage);
    }
  }
}
