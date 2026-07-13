import { PinoLogger } from 'nestjs-pino';

import { runWithOccRetry } from '@retail-inventory-system/common';

import { ReturnDomainException, ReturnErrorCodeEnum } from '../../domain';
import { ReturnWriteConflictError } from './return-write-conflict.error';

// The minimal dependency set the bounded return-write retry core needs: a logger for
// the retry/exhaustion trace and the bounded retry budget. The caller wraps its own
// write (a plain `save`, or a `runInTransaction(...)` for Inspect) in
// `runWithReturnWriteRetry`, so each retried `attempt` re-reads the return request
// afresh and re-runs its version-checked compare-and-swap on a lost race. A local copy
// of the orders/cart helper shape — returns cannot import the orders module (ADR-017).
export interface IReturnWriteRetryDeps {
  logger: PinoLogger;
  // The optimistic-concurrency retry budget — how many attempts a lost CAS may burn
  // before the write surfaces a `409 VERSION_MISMATCH`. Injected from
  // `OCC_RETRY_ATTEMPTS` (ADR-036), never a hardcoded constant.
  maxAttempts: number;
}

// Logging/identity context for the retry trace + the exhaustion error message.
export interface IReturnWriteRetryContext {
  rmaId?: number;
  correlationId?: string;
}

// The reusable bounded optimistic write protocol for the return-request status
// mutators (ADR-036), mirroring the order `runWithOrderWriteRetry` / cart
// `runWithCartWriteRetry`. It runs `attempt()`; a `ReturnWriteConflictError` (a lost
// compare-and-swap on the return-request root version, translated by
// `ReturnRequestTypeormRepository.save`) is retried up to the injected
// `deps.maxAttempts` budget, re-reading the now-current request inside the attempt.
// Every other error — a domain rejection (`RETURN_INVALID_STATUS_TRANSITION`,
// `RETURN_INSPECTION_INVALID`, …) or anything unexpected — propagates immediately and
// is never retried (only the optimistic conflict retries; a state the request
// genuinely forbids is terminal). Exhaustion surfaces a `409 VERSION_MISMATCH` carrying
// the row's current version so the caller can refetch-and-retry.
export async function runWithReturnWriteRetry<T>(
  deps: IReturnWriteRetryDeps,
  attempt: () => Promise<T>,
  context: IReturnWriteRetryContext = {},
): Promise<T> {
  const { rmaId, correlationId } = context;

  return runWithOccRetry(attempt, {
    subject: 'Return request',
    logger: deps.logger,
    maxAttempts: deps.maxAttempts,
    isConflict: (error): error is ReturnWriteConflictError =>
      error instanceof ReturnWriteConflictError,
    retryContext: (conflict) => ({
      correlationId,
      rmaId: rmaId ?? conflict.rmaId,
      currentVersion: conflict.currentVersion,
    }),
    exhaustedContext: (conflict) => ({ correlationId, rmaId: rmaId ?? conflict.rmaId }),
    onExhausted: (conflict, attempts) => {
      throw new ReturnDomainException(
        ReturnErrorCodeEnum.RETURN_VERSION_MISMATCH,
        `Return request ${rmaId ?? conflict.rmaId} write lost the optimistic race after ${attempts} attempts`,
        { currentVersion: conflict.currentVersion },
      );
    },
  });
}
