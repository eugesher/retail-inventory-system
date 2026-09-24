import { PinoLogger } from 'nestjs-pino';

import { runWithOccRetry } from '@retail-inventory-system/common';

import { ReturnDomainException, ReturnErrorCodeEnum } from '../../domain';
import { ReturnWriteConflictError } from './return-write-conflict.error';

export interface IReturnWriteRetryDeps {
  logger: PinoLogger;
  maxAttempts: number;
}

export interface IReturnWriteRetryContext {
  rmaId?: number;
  correlationId?: string;
}

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
