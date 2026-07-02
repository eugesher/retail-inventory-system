import { PinoLogger } from 'nestjs-pino';

import { OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import { OrderWriteConflictError } from './order-write-conflict.error';

// The minimal dependency set the bounded order-write retry core needs: a logger for
// the retry/exhaustion trace and the bounded retry budget. Unlike the inventory
// protocol (`runWithStockWriteRetry`) this threads no transaction port — the
// caller wraps its own `runInTransaction(...)` in `runWithOrderWriteRetry`, so each
// retried `attempt` opens a FRESH transaction (a new snapshot + a new
// version-checked compare-and-swap) on a lost race.
export interface IOrderWriteRetryDeps {
  logger: PinoLogger;
  // The optimistic-concurrency retry budget — how many attempts a lost CAS may burn
  // before the write surfaces a `409 VERSION_MISMATCH`. Injected from
  // `OCC_RETRY_ATTEMPTS` (ADR-036), never a hardcoded constant.
  maxAttempts: number;
}

// Logging/identity context for the retry trace + the exhaustion error message.
export interface IOrderWriteRetryContext {
  orderId?: number;
  correlationId?: string;
}

// The reusable bounded optimistic write protocol for the order status mutators
// (ADR-036), mirroring inventory's `runWithStockWriteRetry` and cart's
// `runWithCartWriteRetry`. It runs `attempt()` (which owns a `runInTransaction`); an
// `OrderWriteConflictError` (a lost compare-and-swap on the order root version,
// translated by `OrderTypeormRepository.save`) rolls that transaction back and is
// retried up to the injected `deps.maxAttempts` budget, re-reading the now-current
// order inside a fresh transaction. Every other error — a domain rejection
// (`ORDER_NOT_CANCELLABLE`, `FULFILLMENT_INVALID_STATUS_TRANSITION`,
// `PAYMENT_INVALID_STATUS_TRANSITION`, …) or anything unexpected — propagates
// immediately and is never retried (the stock-protocol rule: only the optimistic
// conflict retries; a state the request genuinely forbids is terminal). Exhaustion
// surfaces a `409 VERSION_MISMATCH` carrying the row's current version so the caller
// can refetch-and-retry.
export async function runWithOrderWriteRetry<T>(
  deps: IOrderWriteRetryDeps,
  attempt: () => Promise<T>,
  context: IOrderWriteRetryContext = {},
): Promise<T> {
  const { logger, maxAttempts } = deps;
  const { orderId, correlationId } = context;

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof OrderWriteConflictError)) {
        throw error;
      }
      if (attemptNo >= maxAttempts) {
        logger.warn(
          { correlationId, orderId: orderId ?? error.orderId, attempts: attemptNo, maxAttempts },
          'Order write conflict exhausted retry budget',
        );
        throw new OrderDomainException(
          OrderErrorCodeEnum.ORDER_VERSION_MISMATCH,
          `Order ${orderId ?? error.orderId} write lost the optimistic race after ${attemptNo} attempts`,
          { currentVersion: error.currentVersion },
        );
      }
      // OCC retries log at `info` (ADR-036): a lost compare-and-swap is a normal,
      // expected outcome under contention, and the concurrency tests assert this
      // trace fires with the attempt count + the version the winner left behind.
      logger.info(
        {
          correlationId,
          orderId: orderId ?? error.orderId,
          attempt: attemptNo,
          maxAttempts,
          currentVersion: error.currentVersion,
        },
        'Order write conflict — retrying with a fresh read',
      );
    }
  }

  // Unreachable: the final attempt either returns or throws inside the loop.
  throw new Error('runWithOrderWriteRetry: optimistic retry loop exited unexpectedly');
}
