import { PinoLogger } from 'nestjs-pino';

import { Cart, CartDomainException, CartErrorCodeEnum } from '../../domain';
import { CartWriteConflictError } from './cart-write-conflict.error';

// The minimal dependency set the bounded cart-write retry core needs: a logger for
// the retry/exhaustion trace and the bounded retry budget. Unlike the inventory
// protocol (`runWithStockWriteRetry`), no transaction port is threaded here — the
// version-checked compare-and-swap and its unit of work live inside
// `CartTypeormRepository.save`, so an attempt is a plain `async () => …` the
// helper re-invokes on a lost race.
export interface ICartWriteRetryDeps {
  logger: PinoLogger;
  // The optimistic-concurrency retry budget — how many attempts a lost CAS may
  // burn before the write surfaces a `409 VERSION_MISMATCH`. Injected from
  // `OCC_RETRY_ATTEMPTS` (ADR-036), never a hardcoded constant. The caller passes
  // `1` when the client pinned an `If-Match` version, so a lost race is reported
  // immediately (HTTP precondition-failed semantics — the pinned version moved,
  // do not silently retry to a different outcome).
  maxAttempts: number;
}

// Logging/identity context for the retry trace + the exhaustion error message.
export interface ICartWriteRetryContext {
  cartId?: string;
  correlationId?: string;
}

// The `If-Match` precondition. When the client supplied a version and it no longer
// matches the freshly-loaded cart, the client's view is stale — reject with a
// `409 VERSION_MISMATCH` **immediately** (do not retry: retrying would let a
// last-writer-wins loop override the precondition the client explicitly asked to
// enforce). `details.currentVersion` carries the row's actual version so the
// caller can refetch. A `undefined` expected version means the client did not send
// `If-Match`, so this is a no-op and the bounded retry loop governs the outcome.
export function assertCartVersion(cart: Cart, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && cart.version !== expectedVersion) {
    throw new CartDomainException(
      CartErrorCodeEnum.CART_VERSION_MISMATCH,
      `Cart ${String(cart.id)}: If-Match version ${expectedVersion} does not match the current version ${cart.version}`,
      { currentVersion: cart.version },
    );
  }
}

// The reusable bounded optimistic write protocol for the cart mutators (ADR-036),
// mirroring inventory's `runWithStockWriteRetry`. It runs `attempt()`; a
// `CartWriteConflictError` (a lost compare-and-swap on the cart root version,
// translated by `CartTypeormRepository.save`) is retried up to the injected
// `deps.maxAttempts` budget, re-reading the now-current cart inside the attempt.
// Every other error — a domain rejection (`CART_LINE_NOT_FOUND`, a stale
// `If-Match` via `assertCartVersion`, an `INVENTORY_OUT_OF_STOCK` reserve) or
// anything unexpected — propagates immediately and is never retried. Exhaustion
// surfaces a `409 VERSION_MISMATCH` carrying the row's current version.
export async function runWithCartWriteRetry<T>(
  deps: ICartWriteRetryDeps,
  attempt: () => Promise<T>,
  context: ICartWriteRetryContext = {},
): Promise<T> {
  const { logger, maxAttempts } = deps;
  const { cartId, correlationId } = context;

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    try {
      return await attempt();
    } catch (error) {
      if (!(error instanceof CartWriteConflictError)) {
        throw error;
      }
      if (attemptNo >= maxAttempts) {
        logger.warn(
          { correlationId, cartId, attempts: attemptNo, maxAttempts },
          'Cart write conflict exhausted retry budget',
        );
        throw new CartDomainException(
          CartErrorCodeEnum.CART_VERSION_MISMATCH,
          `Cart ${cartId ?? error.cartId} write lost the optimistic race after ${attemptNo} attempts`,
          { currentVersion: error.currentVersion },
        );
      }
      // OCC retries log at `info` (ADR-036): a lost compare-and-swap is a normal,
      // expected outcome under contention, and the concurrency tests assert this
      // trace fires with the attempt count + the version the winner left behind.
      logger.info(
        {
          correlationId,
          cartId,
          attempt: attemptNo,
          maxAttempts,
          currentVersion: error.currentVersion,
        },
        'Cart write conflict — retrying with a fresh read',
      );
    }
  }

  // Unreachable: the final attempt either returns or throws inside the loop.
  throw new Error('runWithCartWriteRetry: optimistic retry loop exited unexpectedly');
}
