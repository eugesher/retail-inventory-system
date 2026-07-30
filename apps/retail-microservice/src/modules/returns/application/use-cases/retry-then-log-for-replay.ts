import { PinoLogger } from 'nestjs-pino';

export interface IRetryThenLogForReplayOptions {
  // Retries are immediate — there is no backoff. **A retry after a timeout races the original**,
  // because a timeout does not cancel an RPC that is still travelling; raising this budget widens
  // that window rather than the resilience. See the note on `replayMessage`.
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
// **The restock is idempotent against a CONCURRENT redelivery too.** That is load-bearing here,
// because a retry fired after a **timeout** travels alongside the original — a timeout does not
// cancel the RPC. Inventory's probe on `returnRequestId` reads outside its write transaction and is
// only the fast path; the guarantee is `UC_STOCK_MOVEMENT_DEDUPE` (migration `1783872387242`), the
// ledger UNIQUE whose generated key is scoped to `type IN ('sale','return')` and reaches down to
// `(variant_id, stock_location_id)` — so it holds a multi-line restock without rejecting its second
// line. `test/concurrent-commit-sale.e2e-spec.ts` pins the restock half of that.
//
// So `maxAttempts` is a **latency** budget, not a safety one: the caller awaits this inside its own
// HTTP request. It was previously justified as a safety bound, before the UNIQUE existed.
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
