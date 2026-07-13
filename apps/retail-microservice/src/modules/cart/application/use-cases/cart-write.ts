import { PinoLogger } from 'nestjs-pino';

import { runWithOccRetry } from '@retail-inventory-system/common';

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

// The cart's binding of the shared OCC retry protocol (ADR-036/045). The loop, the log levels
// and both message texts live in `runWithOccRetry`; what stays here is what only the cart knows
// — its conflict type (a lost CAS on the cart root version, translated by
// `CartTypeormRepository.save`), the fields on its trace, and the `409 CART_VERSION_MISMATCH`
// it raises when the budget runs out.
export async function runWithCartWriteRetry<T>(
  deps: ICartWriteRetryDeps,
  attempt: () => Promise<T>,
  context: ICartWriteRetryContext = {},
): Promise<T> {
  const { cartId, correlationId } = context;

  return runWithOccRetry(attempt, {
    subject: 'Cart',
    logger: deps.logger,
    maxAttempts: deps.maxAttempts,
    isConflict: (error): error is CartWriteConflictError => error instanceof CartWriteConflictError,
    retryContext: (conflict) => ({
      correlationId,
      cartId,
      currentVersion: conflict.currentVersion,
    }),
    exhaustedContext: () => ({ correlationId, cartId }),
    onExhausted: (conflict, attempts) => {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_VERSION_MISMATCH,
        `Cart ${cartId ?? conflict.cartId} write lost the optimistic race after ${attempts} attempts`,
        { currentVersion: conflict.currentVersion },
      );
    },
  });
}
