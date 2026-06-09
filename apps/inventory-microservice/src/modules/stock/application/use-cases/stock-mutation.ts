import { PinoLogger } from 'nestjs-pino';

import { InventoryDomainException, InventoryErrorCodeEnum, StockLevel } from '../../domain';
import {
  IStockCachePort,
  IStockRepositoryPort,
  IStockWithInvalidationOptions,
  ITransactionPort,
} from '../ports';
import { StockWriteConflictError } from './stock-write-conflict.error';

// Bounded retry budget for the optimistic write. Generous enough to absorb
// realistic contention on a single `(variantId, stockLocationId)` row; once it is
// exhausted the caller gets a 409 it can retry. Each attempt opens a fresh
// transaction, so it re-reads the now-current version under a new snapshot.
const MAX_WRITE_ATTEMPTS = 5;

export interface IStockMutationDeps {
  transactionPort: ITransactionPort;
  repository: IStockRepositoryPort;
  stockCache: IStockCachePort;
  logger: PinoLogger;
}

export interface IApplyOnHandChangeParams {
  variantId: number;
  stockLocationId: string;
  delta: number;
  correlationId?: string;
}

// The shared read-modify-write for every on-hand mutation (Receive / Adjust),
// so the write protocol lives in exactly one place (ADR-027). The protocol is:
//   post-commit cache invalidation (ADR-023)
//     └─ bounded optimistic retry (ADR-027 §concurrency)
//          └─ transaction: find-or-init → `changeOnHand` → version-checked persist
// A domain rejection (e.g. a below-zero Adjust → `STOCK_RESULT_NEGATIVE`)
// propagates immediately and is NOT retried; only a `StockWriteConflictError`
// (a lost compare-and-swap or a first-touch INSERT race) triggers a retry.
export async function applyOnHandChange(
  deps: IStockMutationDeps,
  params: IApplyOnHandChangeParams,
): Promise<StockLevel> {
  const opts: IStockWithInvalidationOptions = { correlationId: params.correlationId };
  return deps.stockCache.withInvalidation(
    () => runWithRetry(deps, params),
    (saved) => [{ variantId: saved.variantId, stockLocationId: saved.stockLocationId }],
    opts,
  );
}

async function runWithRetry(
  deps: IStockMutationDeps,
  params: IApplyOnHandChangeParams,
): Promise<StockLevel> {
  const { transactionPort, repository, logger } = deps;
  const { variantId, stockLocationId, delta, correlationId } = params;

  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    try {
      return await transactionPort.runInTransaction(async (scope) => {
        const existing = await repository.findStockLevel(variantId, stockLocationId, scope);
        // Capture the optimistic token BEFORE `changeOnHand` bumps it; null marks
        // a first-touch INSERT.
        const expectedVersion = existing ? existing.version : null;
        const level = existing ?? StockLevel.initialAt(variantId, stockLocationId);
        level.changeOnHand(delta);
        return repository.persistStockLevelChange(level, expectedVersion, scope);
      });
    } catch (error) {
      // Only an optimistic conflict is retryable. Domain rejections (below-zero,
      // bad delta) and anything else propagate untouched.
      if (!(error instanceof StockWriteConflictError)) {
        throw error;
      }
      if (attempt >= MAX_WRITE_ATTEMPTS) {
        logger.warn(
          { correlationId, variantId, stockLocationId, attempts: attempt },
          'Stock write conflict exhausted retry budget',
        );
        throw new InventoryDomainException(
          InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT,
          `Stock write for variant ${variantId} @ ${stockLocationId} lost the optimistic race after ${attempt} attempts`,
        );
      }
      logger.debug(
        { correlationId, variantId, stockLocationId, attempt },
        'Stock write conflict — retrying with a fresh read',
      );
    }
  }

  // Unreachable: the final attempt either returns or throws inside the loop.
  throw new Error('applyOnHandChange: optimistic retry loop exited unexpectedly');
}
