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

// The minimal dependency set the bounded-retry core needs: a transaction port to
// open a fresh unit of work per attempt, a logger for the retry/exhaustion trace, and
// the bounded retry budget. `IStockMutationDeps` is a superset, so it satisfies this
// structurally.
export interface IStockWriteRetryDeps {
  transactionPort: ITransactionPort;
  logger: PinoLogger;
  // The optimistic-concurrency retry budget — how many fresh-transaction attempts a lost
  // compare-and-swap may burn before the write surfaces a `409 STOCK_WRITE_CONFLICT`.
  // Injected from `OCC_RETRY_ATTEMPTS` (ADR-036), never a hardcoded constant: the use
  // case resolves the value-provider token and threads it in, so the budget is a single
  // env-driven knob (default 5) rather than a literal buried in the protocol.
  maxAttempts: number;
}

// Logging/identity context for the retry trace + the exhaustion error message.
// Optional throughout: a multi-row write (Release) may span several
// (variantId, stockLocationId) pairs, so it omits the per-row identity.
export interface IStockWriteRetryContext {
  variantId?: number;
  stockLocationId?: string;
  correlationId?: string;
}

// The stock module's binding of the shared OCC retry protocol (ADR-036/045), and the one that
// is not a plain delegation: it is the ONLY caller whose attempt runs inside a transaction —
// `transactionPort.runInTransaction` opens a fresh snapshot per attempt, so a retry re-reads
// the now-current rows rather than the stale ones it lost against. The other three modules do
// their compare-and-swap inside `repository.save`, so their attempt is a bare thunk.
//
// The loop, the log levels and both message texts come from `runWithOccRetry`. What stays here
// is what only inventory knows: `StockWriteConflictError` (a lost CAS on
// `persistStockLevelChange`, or a lost INSERT race on the reservation UNIQUE triple), the row
// identity on the trace, and the terminal `409 STOCK_WRITE_CONFLICT`.
//
// The retry trace takes `(variantId, stockLocationId)` from the CONFLICT, not from `context`:
// for a multi-row write (Release / Allocate) the losing row is more precise than the caller's
// context. `fromVersion` is the `expectedVersion` the CAS targeted — `null` on a first-touch
// INSERT race, and the conflict path is deliberately query-free, so the winning `toVersion` is
// never read back.
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
