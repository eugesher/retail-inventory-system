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
// **The inventory operations behind this are idempotent against a SEQUENTIAL replay only.** Their
// probes read outside their transactions and no UNIQUE backs them, so a retry that fires while the
// original is still in flight — which is what a timeout produces — can apply twice. That is the
// hazard this helper's `maxAttempts` sits on top of, and it is why raising it is not free.
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
