import { PinoLogger } from 'nestjs-pino';

import { runWithOccRetry } from '@retail-inventory-system/common';

import { OrderDomainException, OrderErrorCodeEnum } from '../../domain';
import { OrderWriteConflictError } from './order-write-conflict.error';

export interface IOrderWriteRetryDeps {
  logger: PinoLogger;
  maxAttempts: number;
}

export interface IOrderWriteRetryContext {
  orderId?: number;
  correlationId?: string;
}

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
