import { PinoLogger } from 'nestjs-pino';

export interface IRetryThenLogForReplayOptions {
  // Bounded attempt budget — retries are immediate (no backoff), the realistic failure
  // being a transient RMQ hiccup the broker recovers from; a backoff is a later
  // refinement that would live here, in the one place the posture is defined.
  maxAttempts: number;
  logger: PinoLogger;
  correlationId: string;
  // Short operation label for the per-attempt warn, e.g. 'Cancel-Allocation' / 'Commit
  // Sale' (the message is `${label} failed — retrying`).
  label: string;
  // Identifying fields logged on every retry warn and on the final poison-record error
  // (the full payload an operator needs to replay the operation).
  context: Record<string, unknown>;
  // The terminal error message — the post-commit posture differs per caller (an
  // allocation release over-holds the stock, a Commit Sale replay is idempotent on
  // `fulfillmentId`), so each caller spells out what awaiting-replay means.
  replayMessage: string;
}

// Runs a post-commit inventory `operation`, retrying up to `maxAttempts`. On a
// persistent failure it logs the full `context` at `error` (a poison record for operator
// replay) and returns **WITHOUT throwing**: the local transaction has already committed
// and must not be rolled back (the post-commit eventual-consistency posture, ADR-031). A
// failed operation leaves stock over-held/undecremented until a manual replay frees it —
// it never corrupts the counters. Shared by Cancel Order / Cancel Line (allocation
// release) and Ship (Commit Sale) so the retry/log-for-replay policy lives in exactly one
// place (the `order-access` shared-helper precedent).
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
