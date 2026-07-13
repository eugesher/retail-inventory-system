import { PinoLogger } from 'nestjs-pino';

import { runWithOccRetry } from '@retail-inventory-system/common';

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
  const { orderId, correlationId } = context;

  return runWithOccRetry(attempt, {
    subject: 'Order',
    logger: deps.logger,
    maxAttempts: deps.maxAttempts,
    isConflict: (error): error is OrderWriteConflictError =>
      error instanceof OrderWriteConflictError,
    retryContext: (conflict) => ({
      correlationId,
      orderId: orderId ?? conflict.orderId,
      currentVersion: conflict.currentVersion,
    }),
    exhaustedContext: (conflict) => ({ correlationId, orderId: orderId ?? conflict.orderId }),
    onExhausted: (conflict, attempts) => {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_VERSION_MISMATCH,
        `Order ${orderId ?? conflict.orderId} write lost the optimistic race after ${attempts} attempts`,
        { currentVersion: conflict.currentVersion },
      );
    },
  });
}
