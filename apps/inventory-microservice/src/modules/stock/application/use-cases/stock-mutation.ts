import { PinoLogger } from 'nestjs-pino';

import { runWithOccRetry } from '@retail-inventory-system/common';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockLevel,
  StockMovement,
} from '../../domain';
import {
  IStockCachePort,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  IStockWithInvalidationOptions,
  ITransactionPort,
  ITransactionScope,
} from '../ports';
import { StockWriteConflictError } from './stock-write-conflict.error';

export interface IStockWriteRetryDeps {
  transactionPort: ITransactionPort;
  logger: PinoLogger;
  maxAttempts: number;
}

export interface IStockWriteRetryContext {
  variantId?: number;
  stockLocationId?: string;
  correlationId?: string;
}

export async function runWithStockWriteRetry<T>(
  deps: IStockWriteRetryDeps,
  attempt: (scope: ITransactionScope) => Promise<T>,
  context: IStockWriteRetryContext = {},
): Promise<T> {
  const { transactionPort, logger, maxAttempts } = deps;
  const { variantId, stockLocationId, correlationId } = context;

  return runWithOccRetry(() => transactionPort.runInTransaction((scope) => attempt(scope)), {
    subject: 'Stock',
    logger,
    maxAttempts,
    isConflict: (error): error is StockWriteConflictError =>
      error instanceof StockWriteConflictError,
    retryContext: (conflict) => ({
      correlationId,
      variantId: conflict.variantId,
      stockLocationId: conflict.stockLocationId,
      fromVersion: conflict.expectedVersion ?? undefined,
    }),
    exhaustedContext: () => ({ correlationId, variantId, stockLocationId }),
    onExhausted: (_conflict, attempts) => {
      const target =
        variantId !== undefined ? `for variant ${variantId} @ ${stockLocationId} ` : '';
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT,
        `Stock write ${target}lost the optimistic race after ${attempts} attempts`,
      );
    },
  });
}

export interface IStockMutationDeps extends IStockWriteRetryDeps {
  repository: IStockRepositoryPort;
  movementRepository: IStockMovementRepositoryPort;
  stockCache: IStockCachePort;
}

export interface IApplyOnHandChangeParams {
  variantId: number;
  stockLocationId: string;
  delta: number;
  correlationId?: string;
  buildMovement?: (saved: StockLevel) => StockMovement;
}

export interface IApplyOnHandChangeResult {
  level: StockLevel;
  movement: StockMovement | null;
}

export async function applyOnHandChange(
  deps: IStockMutationDeps,
  params: IApplyOnHandChangeParams,
): Promise<IApplyOnHandChangeResult> {
  const { repository, movementRepository } = deps;
  const { variantId, stockLocationId, delta, correlationId, buildMovement } = params;
  const opts: IStockWithInvalidationOptions = { correlationId };

  return deps.stockCache.withInvalidation(
    () =>
      runWithStockWriteRetry(
        deps,
        async (scope): Promise<IApplyOnHandChangeResult> => {
          const existing = await repository.findStockLevel(variantId, stockLocationId, scope);
          const expectedVersion = existing ? existing.version : null;
          const level = existing ?? StockLevel.initialAt(variantId, stockLocationId);
          level.changeOnHand(delta);
          const saved = await repository.persistStockLevelChange(level, expectedVersion, scope);
          const movement = buildMovement
            ? await movementRepository.append(buildMovement(saved), scope)
            : null;
          return { level: saved, movement };
        },
        { variantId, stockLocationId, correlationId },
      ),
    (result) => [
      { variantId: result.level.variantId, stockLocationId: result.level.stockLocationId },
    ],
    opts,
  );
}
