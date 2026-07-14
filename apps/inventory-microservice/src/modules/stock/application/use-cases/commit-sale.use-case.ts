import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  ICommitSalePayload,
  ICommitSaleResult,
  ICommitSaleResultEntry,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import { StockCommittedEvent, StockLevel, StockMovement } from '../../domain';
import {
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  ITransactionPort,
  ITransactionScope,
  OCC_RETRY_ATTEMPTS,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { LedgerReplayError } from './ledger-replay.error';
import { maybeEmitLowStock } from './low-stock.emitter';
import { emitMovementRecorded } from './movement-recorded.emitter';
import { isDuplicateEntryError } from './mysql-error.util';
import {
  INormalizedReservationLine,
  levelKey,
  loadDistinctLevels,
  normalizeReservationLines,
  requireDistinctLevels,
} from './reservation-mutation';
import { runWithStockWriteRetry } from './stock-mutation';

// The ledger-reference family the commit-sale idempotency probe + the `sale`
// movements key on: `(reference_type='fulfillment', reference_id=fulfillmentId)`.
const FULFILLMENT_REFERENCE_TYPE = 'fulfillment';

// One committed line + the ledger row that records it, carried out of the
// transaction so the post-commit emits fire per line.
interface ICommittedLine {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  movement: StockMovement;
}

// One distinct persisted level + the total quantity shipped from it, carried out
// so the post-commit low-stock re-check fires once per level with a negative delta
// (multiple lines may share a level).
interface ICommittedLevel {
  level: StockLevel;
  totalQuantity: number;
}

interface ICommitOutcome {
  lines: ICommittedLine[];
  levels: ICommittedLevel[];
}

// **The operation on which stock physically leaves** (ADR-031). Per line it decrements *both*
// `quantity_on_hand` and `quantity_allocated` in one `StockLevel.commitSale` and appends a
// strictly-negative `sale` movement. `available` does not move — both counters subtract from it, so
// they cancel: shipping stock that was already promised neither frees nor consumes availability.
//
// **Idempotent on `fulfillmentId`, including against CONCURRENT redeliveries.** Retail drives this
// *after* its own ship transaction has committed, so a transient RMQ failure re-delivers a request
// whose work is already durable — and the broker never promises the redelivery waits for the
// original to finish. Two mechanisms, in that order: the `existsByReference` probe short-circuits
// the sequential replay (the common case), and `UC_STOCK_MOVEMENT_DEDUPE` — a UNIQUE on the ledger —
// is what actually holds when two deliveries are in flight at once. **The probe is an optimisation;
// the constraint is the guarantee.** Both paths return the same no-op result and neither throws.
//
// **All-lines-atomic.** Every line is computed in memory, where a drift or a `STOCK_RESULT_NEGATIVE`
// throws, before a single persist. A rejection on any line rolls the whole transaction back — there
// is no such thing as a half-shipped commit.
//
// **No reservation row is touched.** The holds were already committed at allocate-time; by the time
// stock ships, there is nothing left holding it.
@Injectable()
export class CommitSaleUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_MOVEMENT_REPOSITORY)
    private readonly movementRepository: IStockMovementRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @Inject(STOCK_EVENTS_PUBLISHER)
    private readonly publisher: IStockEventsPublisherPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @InjectPinoLogger(CommitSaleUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: ICommitSalePayload): Promise<ICommitSaleResult> {
    const { orderId, fulfillmentId, correlationId } = payload;
    const actorId = payload.actorId ?? null;

    this.logger.info(
      { correlationId, orderId, fulfillmentId, lineCount: payload.lines?.length },
      'Received RPC: commit sale',
    );

    const lines = normalizeReservationLines(payload.lines, 'Commit sale');
    // Two lines on one level would collide on `UC_STOCK_MOVEMENT_DEDUPE` and the catch
    // below would misread the collision as a replay. Rejecting it here is what keeps
    // that error's meaning single — see `requireDistinctLevels`.
    requireDistinctLevels(lines, 'Commit sale');

    // The FAST PATH, not the guard (ADR-031). A `sale` movement already referencing this
    // fulfillment means the commit happened, so re-return the lines without decrementing;
    // skipping `withInvalidation` entirely is right, because nothing changed.
    //
    // **This probe cannot make the operation idempotent, and must not be read as if it
    // did.** It is a READ outside the write transaction, so two *concurrent* deliveries
    // of one `fulfillmentId` both see "not yet committed" and both fall through. What
    // makes the operation idempotent is `UC_STOCK_MOVEMENT_DEDUPE` (migration
    // `1783872387242`) — a UNIQUE the losing writer's INSERT breaks, caught below. The
    // probe is kept because a redelivery that arrives *after* the first call finished is
    // the overwhelmingly common case, and short-circuiting it costs one indexed SELECT
    // instead of a whole transaction that would only roll back.
    const alreadyCommitted = await this.movementRepository.existsByReference(
      FULFILLMENT_REFERENCE_TYPE,
      fulfillmentId,
    );
    if (alreadyCommitted) {
      this.logger.info(
        { correlationId, orderId, fulfillmentId },
        'Commit sale replay — fulfillment already committed, returning prior result without decrementing',
      );
      return { committed: lines.map((line) => this.toEntry(line)) };
    }

    let outcome: ICommitOutcome;
    try {
      outcome = await this.stockCache.withInvalidation(
        () =>
          runWithStockWriteRetry(
            {
              transactionPort: this.transactionPort,
              logger: this.logger,
              maxAttempts: this.maxAttempts,
            },
            (scope) => this.commitOnce(scope, orderId, fulfillmentId, lines, actorId),
            { correlationId },
          ),
        // `withInvalidation` dedupes by variantId and wipes a per-variant prefix
        // covering every location facet, so the raw per-line items are enough.
        (result) =>
          result.lines.map((row) => ({
            variantId: row.variantId,
            stockLocationId: row.stockLocationId,
          })),
        { correlationId },
      );
    } catch (error) {
      // THE GUARD, in its two forms. A concurrent delivery beat us to the ledger, and we
      // learned it either by SEEING its `sale` row under our own snapshot
      // (`LedgerReplayError`, phase 0) or by breaking `UC_STOCK_MOVEMENT_DEDUPE` on the
      // INSERT (`isDuplicateEntryError`) when neither snapshot saw the other. Either way
      // the whole transaction rolled back, so this attempt decremented nothing — the
      // outcome is the winner's, and it is exactly what the probe returns for a
      // sequential replay.
      //
      // **This must not rethrow.** The caller is an `@MessagePattern`, and an exception
      // out of one is blind-redelivered by the broker in a hot loop — which would put a
      // *third* delivery on the same fulfillment. Neither error is a
      // `StockWriteConflictError`, so `runWithStockWriteRetry` correctly does not retry
      // them either: a retry would just re-lose the same race.
      if (error instanceof LedgerReplayError || isDuplicateEntryError(error)) {
        this.logger.info(
          { correlationId, orderId, fulfillmentId },
          'Commit sale lost a concurrent race — the ledger already holds this fulfillment, nothing decremented',
        );
        return { committed: lines.map((line) => this.toEntry(line)) };
      }
      throw error;
    }

    this.logger.info(
      { correlationId, orderId, fulfillmentId, committedCount: outcome.lines.length },
      'Stock committed — allocated units shipped',
    );

    // Post-commit, best-effort (ADR-020): per line the committed + recorded events,
    // and per distinct level a low-stock re-check (on-hand fell, so the delta is
    // negative — the magnitude is immaterial to `maybeEmitLowStock`).
    await Promise.all([
      ...outcome.lines.map((row) => this.emitCommitted(row, orderId, fulfillmentId, correlationId)),
      ...outcome.levels.map((entry) =>
        maybeEmitLowStock(
          this.publisher,
          this.logger,
          entry.level,
          -entry.totalQuantity,
          correlationId,
        ),
      ),
    ]);

    return { committed: outcome.lines.map((row) => this.toEntry(row)) };
  }

  // One transactional attempt: compute every line in memory first (so a drift /
  // negative rejection leaves nothing persisted for ANY line), then write all.
  // Re-reads each level fresh under the scope so a retried attempt never
  // double-applies.
  private async commitOnce(
    scope: ITransactionScope,
    orderId: number,
    fulfillmentId: string,
    lines: INormalizedReservationLine[],
    actorId: string | null,
  ): Promise<ICommitOutcome> {
    // Phase 0 — re-probe UNDER THE SCOPE, so the question is asked of the very snapshot
    // this attempt will write in. If a concurrent delivery committed before this
    // transaction opened, its `sale` row is visible here and we must unwind NOW: phase 2
    // would otherwise re-read a level whose `quantity_allocated` the winner already
    // consumed and throw `StockLevel.commitSale`'s drift `Error` — a 500 out of an
    // `@MessagePattern`, which the broker blind-redelivers in a hot loop. See
    // `LedgerReplayError` for why this and `UC_STOCK_MOVEMENT_DEDUPE` cover disjoint
    // windows and both are needed.
    if (
      await this.movementRepository.existsByReference(
        FULFILLMENT_REFERENCE_TYPE,
        fulfillmentId,
        scope,
      )
    ) {
      throw new LedgerReplayError(FULFILLMENT_REFERENCE_TYPE, fulfillmentId);
    }

    // Phase 1 — load each distinct level once, capturing its optimistic token.
    const levels = await loadDistinctLevels(this.repository, lines, scope);

    // Phase 2 — compute per line (in-memory). `commitSale` throws here (allocated
    // drift → plain Error/500; on-hand shortfall → STOCK_RESULT_NEGATIVE/409),
    // before any write below. Accumulate the per-level shipped total for the
    // post-commit low-stock re-check.
    const computed: { line: INormalizedReservationLine; movement: StockMovement }[] = [];
    const totals = new Map<string, number>();
    for (const line of lines) {
      const key = levelKey(line.variantId, line.stockLocationId);
      const loaded = levels.get(key);
      // Unreachable: phase 1 inserted a level for every line's key.
      if (loaded === undefined) {
        throw new Error(
          `Commit sale: level for ${line.variantId} @ ${line.stockLocationId} not loaded`,
        );
      }
      loaded.level.commitSale(line.quantity);
      totals.set(key, (totals.get(key) ?? 0) + line.quantity);

      computed.push({
        line,
        movement: StockMovement.record({
          variantId: line.variantId,
          stockLocationId: line.stockLocationId,
          type: StockMovementTypeEnum.SALE,
          quantity: -line.quantity, // strictly negative — the fixed `sale` sign
          reasonCode: null,
          referenceType: FULFILLMENT_REFERENCE_TYPE,
          referenceId: fulfillmentId,
          actorId,
        }),
      });
    }

    // Phase 3 — write everything (all lines validated). No reservation rows touched.
    const committedLevels: ICommittedLevel[] = [];
    for (const [key, { level, expectedVersion }] of levels.entries()) {
      const saved = await this.repository.persistStockLevelChange(level, expectedVersion, scope);
      committedLevels.push({ level: saved, totalQuantity: totals.get(key) ?? 0 });
    }

    const committedLines: ICommittedLine[] = [];
    for (const { line, movement } of computed) {
      const appended = await this.movementRepository.append(movement, scope);
      committedLines.push({
        variantId: line.variantId,
        stockLocationId: line.stockLocationId,
        quantity: line.quantity,
        movement: appended,
      });
    }

    return { lines: committedLines, levels: committedLevels };
  }

  private toEntry(line: INormalizedReservationLine | ICommittedLine): ICommitSaleResultEntry {
    return {
      variantId: line.variantId,
      stockLocationId: line.stockLocationId,
      quantity: line.quantity,
    };
  }

  private async emitCommitted(
    row: ICommittedLine,
    orderId: number,
    fulfillmentId: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishStockCommitted(
        new StockCommittedEvent({
          variantId: row.variantId,
          stockLocationId: row.stockLocationId,
          quantity: row.quantity,
          orderId,
          fulfillmentId,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: row.variantId },
        'Failed to publish inventory.stock.committed (commit already committed)',
      );
    }

    await emitMovementRecorded(this.publisher, this.logger, row.movement, correlationId);
  }
}
