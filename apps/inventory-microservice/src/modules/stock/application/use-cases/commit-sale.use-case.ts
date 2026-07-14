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
import { maybeEmitLowStock } from './low-stock.emitter';
import { emitMovementRecorded } from './movement-recorded.emitter';
import {
  INormalizedReservationLine,
  levelKey,
  loadDistinctLevels,
  normalizeReservationLines,
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
// **Idempotent on `fulfillmentId`.** Retail drives this **after** its own ship transaction has
// committed, so a transient RMQ failure re-delivers a request whose work is already durable. The
// probe — a lookup on the ledger's `(reference_type, reference_id)` index — runs **before any
// write**: a `sale` movement already naming this fulfillment means the commit happened, so the
// replay decrements nothing and returns the prior result.
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

    // Idempotency-first (ADR-031): if a `sale` movement already references this
    // fulfillment the commit already happened — re-return the request's lines
    // WITHOUT decrementing again. Skipping the whole `withInvalidation` is correct:
    // nothing changed, so there is nothing to invalidate.
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

    const outcome = await this.stockCache.withInvalidation(
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
