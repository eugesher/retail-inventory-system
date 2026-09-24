import { PinoLogger } from 'nestjs-pino';

import { runWithOccRetry } from '@retail-inventory-system/common';

import { Cart, CartDomainException, CartErrorCodeEnum } from '../../domain';
import { CartWriteConflictError } from './cart-write-conflict.error';

export interface ICartWriteRetryDeps {
  logger: PinoLogger;
  maxAttempts: number;
}

export interface ICartWriteRetryContext {
  cartId?: string;
  correlationId?: string;
}

export function assertCartVersion(cart: Cart, expectedVersion: number | undefined): void {
  if (expectedVersion !== undefined && cart.version !== expectedVersion) {
    throw new CartDomainException(
      CartErrorCodeEnum.CART_VERSION_MISMATCH,
      `Cart ${String(cart.id)}: If-Match version ${expectedVersion} does not match the current version ${cart.version}`,
      { currentVersion: cart.version },
    );
  }
}

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
