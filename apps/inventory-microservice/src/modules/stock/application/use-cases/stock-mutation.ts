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

// `IStockMutationDeps` is a superset of this, so it satisfies it structurally — a use case that
// already has the full mutation deps can pass them straight to the retry core.
export interface IStockWriteRetryDeps {
  transactionPort: ITransactionPort;
  logger: PinoLogger;
  // Injected from `OCC_RETRY_ATTEMPTS`, **never a literal** — the budget is one env-driven knob,
  // not a number buried in the protocol (ADR-036).
  maxAttempts: number;
}

// Every field is optional because a multi-row write (Release) spans several
// `(variantId, stockLocationId)` pairs and has no single row identity to give.
export interface IStockWriteRetryContext {
  variantId?: number;
  stockLocationId?: string;
  correlationId?: string;
}

// The stock module's binding of the shared OCC retry protocol (ADR-036/045).
//
// **The transaction is opened HERE, inside the retry loop — not by the caller.** That is what
// makes a retry sound: `runInTransaction` gives each attempt a fresh snapshot, so the second
// attempt re-reads the rows the first one lost against instead of retrying against a stale view.
// The retail bindings invert this — their caller owns the `runInTransaction` and hands the retry
// helper a thunk — so do not copy this file's shape into one of them without checking which end
// owns the unit of work.
//
// The loop, the log levels and both message texts come from `runWithOccRetry`. What stays here is
// what only inventory knows: `StockWriteConflictError` (a lost CAS on `persistStockLevelChange`, or
// a lost INSERT race on the reservation UNIQUE triple), the row identity on the trace, and the
// terminal `STOCK_WRITE_CONFLICT`.
//
// **The retry trace takes `(variantId, stockLocationId)` from the CONFLICT, not from `context`.**
// A multi-row write (Release, Allocate) spans several rows, so the losing row is more precise than
// the caller's idea of what it was writing. `fromVersion` is `null` on a first-touch INSERT race,
// and the conflict path is query-free on purpose — the winning `toVersion` is never read back,
// because reading it would cost a round trip to log a number nobody acts on.
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
