import { PinoLogger } from 'nestjs-pino';

export interface IRetryThenLogForReplayOptions {
  // Retries are immediate — there is no backoff. **A retry after a timeout races the original**,
  // because a timeout does not cancel an RPC that is still travelling; raising this budget widens
  // that window rather than the resilience. See the note on `replayMessage`.
  maxAttempts: number;
  logger: PinoLogger;
  correlationId: string;
  // Short operation label for the per-attempt warn, e.g. 'Cancel-Allocation' / 'Commit
  // Sale' (the message is `${label} failed — retrying`).
  label: string;
  // Identifying fields logged on every retry warn and on the final poison-record error
  // (the full payload an operator needs to replay the operation).
  context: Record<string, unknown>;
  // What awaiting-replay costs, in the caller's own words — the posture differs. A failed allocation
  // release **over-holds** stock; a failed Commit Sale leaves it **undecremented**. Both are
  // conservative: nothing is oversold while an operator replays.
  replayMessage: string;
}

// The one post-commit retry posture, for every cross-service call this module makes after its own
// transaction has committed.
//
// On a persistent failure it logs the whole `context` at `error` — a poison record an operator can
// replay from — and **returns WITHOUT throwing**. The local write is already durable and must not be
// unwound: the money is taken and the box has left (ADR-031).
//
// **The inventory operations behind this are idempotent against a CONCURRENT redelivery too.** That
// is load-bearing for this helper, because a retry fired after a **timeout** travels alongside the
// original — a timeout does not cancel the RPC. Commit Sale and Restock From Return are held by
// `UC_STOCK_MOVEMENT_DEDUPE`, the ledger UNIQUE (migration `1783872387242`); their
// `existsByReference` probes are the fast path, not the guarantee. Cancel-Allocation is
// idempotent-ish by shape (`releaseAllocated` only rejects an over-release).
//
// So `maxAttempts` is a **latency** budget, not a safety one: every caller awaits this inside its
// own HTTP request, so a larger count holds the caller open against a broker that is already down.
// It was previously justified as a safety bound, before the UNIQUE existed.
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
