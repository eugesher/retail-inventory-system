import { PinoLogger } from 'nestjs-pino';

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

// Bounded retry budget for the optimistic write. Generous enough to absorb
// realistic contention on a single `(variantId, stockLocationId)` row; once it is
// exhausted the caller gets a 409 it can retry. Each attempt opens a fresh
// transaction, so it re-reads the now-current version under a new snapshot.
const MAX_WRITE_ATTEMPTS = 5;

// The minimal dependency set the bounded-retry core needs: a transaction port to
// open a fresh unit of work per attempt, and a logger for the retry/exhaustion
// trace. `IStockMutationDeps` is a superset, so it satisfies this structurally.
export interface IStockWriteRetryDeps {
  transactionPort: ITransactionPort;
  logger: PinoLogger;
}

// Logging/identity context for the retry trace + the exhaustion error message.
// Optional throughout: a multi-row write (Release) may span several
// (variantId, stockLocationId) pairs, so it omits the per-row identity.
export interface IStockWriteRetryContext {
  variantId?: number;
  stockLocationId?: string;
  correlationId?: string;
}

// The reusable no-oversell write protocol, generalized out of `applyOnHandChange`
// so every reserve-side use case (Reserve / Release) shares one budget and one
// conflict-translation policy (ADR-030 §3). It opens a fresh transaction per
// attempt and runs `attempt(scope)`; a `StockWriteConflictError` (a lost
// compare-and-swap on `persistStockLevelChange`, or a lost INSERT race on the
// reservation UNIQUE triple translated by the repository) is retried up to
// `MAX_WRITE_ATTEMPTS`, re-reading the now-current rows under a new snapshot.
// Every other error — a domain rejection (`OUT_OF_STOCK`, below-zero) or anything
// unexpected — propagates immediately and is never retried. Exhaustion surfaces a
// 409 `STOCK_WRITE_CONFLICT`.
export async function runWithStockWriteRetry<T>(
  deps: IStockWriteRetryDeps,
  attempt: (scope: ITransactionScope) => Promise<T>,
  context: IStockWriteRetryContext = {},
): Promise<T> {
  const { transactionPort, logger } = deps;
  const { variantId, stockLocationId, correlationId } = context;

  for (let attemptNo = 1; attemptNo <= MAX_WRITE_ATTEMPTS; attemptNo++) {
    try {
      return await transactionPort.runInTransaction((scope) => attempt(scope));
    } catch (error) {
      if (!(error instanceof StockWriteConflictError)) {
        throw error;
      }
      if (attemptNo >= MAX_WRITE_ATTEMPTS) {
        logger.warn(
          { correlationId, variantId, stockLocationId, attempts: attemptNo },
          'Stock write conflict exhausted retry budget',
        );
        const target =
          variantId !== undefined ? `for variant ${variantId} @ ${stockLocationId} ` : '';
        throw new InventoryDomainException(
          InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT,
          `Stock write ${target}lost the optimistic race after ${attemptNo} attempts`,
        );
      }
      logger.debug(
        { correlationId, variantId, stockLocationId, attempt: attemptNo },
        'Stock write conflict — retrying with a fresh read',
      );
    }
  }

  // Unreachable: the final attempt either returns or throws inside the loop.
  throw new Error('runWithStockWriteRetry: optimistic retry loop exited unexpectedly');
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
  // Optional ledger factory (ADR-030 §2). When supplied, the returned movement is
  // appended to `STOCK_MOVEMENT_REPOSITORY` **inside the same transaction** as the
  // counter persist — so a counter change and the audit row that explains it are
  // one atomic unit of work. Receive passes a `receipt` factory, Adjust an
  // `adjustment` one; a caller that only moves the counter omits it. The factory
  // receives the persisted `StockLevel` (its `variantId` / `stockLocationId` are
  // the post-write authority); the signed `quantity` comes from the caller.
  buildMovement?: (saved: StockLevel) => StockMovement;
}

// The result of an on-hand mutation: the persisted level, plus the appended ledger
// row when a `buildMovement` factory was supplied (else `null`). Returning the
// movement lets the use case emit `inventory.stock-movement.recorded` post-commit
// without a re-query — the row already carries its DB-assigned id.
export interface IApplyOnHandChangeResult {
  level: StockLevel;
  movement: StockMovement | null;
}

// The shared read-modify-write for every on-hand mutation (Receive / Adjust),
// so the write protocol lives in exactly one place (ADR-027). The protocol is:
//   post-commit cache invalidation (ADR-023)
//     └─ bounded optimistic retry (`runWithStockWriteRetry`)
//          └─ transaction: find-or-init → `changeOnHand` → version-checked persist
//                          → (optional) append the ledger movement
// A domain rejection (e.g. a below-zero Adjust → `STOCK_RESULT_NEGATIVE`)
// propagates immediately and is NOT retried; only a `StockWriteConflictError`
// (a lost compare-and-swap or a first-touch INSERT race) triggers a retry.
//
// The ledger append runs AFTER the version-checked persist, so a lost CAS throws
// the conflict before any movement is written — a retry re-runs the whole attempt
// from a fresh read and a conflicting attempt never leaves an orphaned ledger row.
// Exactly one movement lands per successful mutation, regardless of how many
// attempts the optimistic race burned.
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
          // Capture the optimistic token BEFORE `changeOnHand` bumps it; null
          // marks a first-touch INSERT.
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
