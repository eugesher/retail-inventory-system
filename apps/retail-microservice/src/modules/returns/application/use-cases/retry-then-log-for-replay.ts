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
  // What awaiting-replay costs, in the caller's own words. A failed restock leaves the returned goods
  // **un-credited** — conservative: stock is understated, never oversold.
  replayMessage: string;
}

// The one post-commit retry posture for this module's cross-service calls.
//
// On a persistent failure it logs the whole `context` at `error` — a poison record an operator can
// replay from — and **returns WITHOUT throwing**. The local write is already durable and must not be
// unwound (ADR-032).
//
// **The restock is idempotent against a SEQUENTIAL replay only.** Inventory's probe on
// `returnRequestId` reads outside its transaction and no UNIQUE backs it, so a retry that fires while
// the original is still in flight — which is what a timeout produces — can credit the same return
// twice. Raising `maxAttempts` widens that window, not the resilience.
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
