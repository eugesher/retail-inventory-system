// A structural logger, NOT `PinoLogger`. `libs/common` is framework-free, and importing
// `nestjs-pino` to write two lines would end that (the `boundaries` rules reject it).
// `PinoLogger` satisfies this shape structurally, so every caller passes its own logger
// unchanged — the `IOccRetryLogger` precedent one folder over (ADR-045).
//
// `warn` and `error`, not `info` and `warn`: this protocol's terminal state is a poison
// record an operator must act on, so it is logged at `error` and nothing here is routine
// enough for `info`.
export interface IRetryThenLogLogger {
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}

export interface IRetryThenLogForReplayOptions {
  // Retries are immediate — there is no backoff. **A retry after a timeout races the original**,
  // because a timeout does not cancel an RPC that is still travelling; raising this budget widens
  // that window rather than the resilience. See the note on `replayMessage`.
  maxAttempts: number;
  logger: IRetryThenLogLogger;
  correlationId: string;
  // Short operation label for the per-attempt warn — `Commit Sale`, `Cancel-Allocation`,
  // `Restock-from-Return` (the message is `${label} failed — retrying`).
  label: string;
  // Identifying fields logged on every retry warn and on the final poison-record error
  // (the full payload an operator needs to replay the operation).
  context: Record<string, unknown>;
  // What awaiting-replay costs, in the caller's own words — the posture differs per
  // operation, so the lib does not guess it. See the table on the function below.
  replayMessage: string;
}

// The one post-commit retry posture, for every cross-service call a module makes after its own
// transaction has committed.
//
// On a persistent failure it logs the whole `context` at `error` — a poison record an operator can
// replay from — and **returns WITHOUT throwing**. The local write is already durable and must not
// be unwound: the money is taken and the box has left (ADR-031).
//
// **`maxAttempts` is a latency budget, not a safety one.** Every caller awaits this inside its own
// HTTP request, so a larger count holds that caller open against a broker that is already down. It
// bounds how long a caller waits; it does not decide whether a retry is safe. **That is decided by
// the callee, and it differs per operation** — which is why this lib refuses to make one claim
// about all of them:
//
// | Call | What makes a REDELIVERY safe | Where |
// | --- | --- | --- |
// | Commit Sale | `UC_STOCK_MOVEMENT_DEDUPE`, keyed on `fulfillmentId` | ledger UNIQUE (migration `1783872387242`) |
// | Restock from Return | the same UNIQUE, keyed on `returnRequestId` | ″ |
// | Cancel-Allocation | the caller-supplied `operationKey` on the release movement | ledger UNIQUE (ADR-057) |
//
// Each of those is an **identity of the operation**, which is the only thing that makes a second
// delivery recognisable as the same work. A quantity check is not one: it can only refuse to go
// negative, and on a counter several operations share, "there is still enough to subtract" does not
// mean "this subtraction has not happened yet" (ADR-057 records what that cost).
//
// This helper lives in `libs/common` rather than in each module because the isolation rule forbids
// the returns module from importing the orders module's copy, which is the same forced-duplication
// ADR-043 lifted for `ITransactionPort` and `OCC_RETRY_ATTEMPTS`. Nothing in it is retail-specific:
// no domain type, no transport, no framework (ADR-056).
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
