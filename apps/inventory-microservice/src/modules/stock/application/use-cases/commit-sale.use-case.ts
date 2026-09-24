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

const FULFILLMENT_REFERENCE_TYPE = 'fulfillment';

interface ICommittedLine {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  movement: StockMovement;
}

interface ICommittedLevel {
  level: StockLevel;
  totalQuantity: number;
}

interface ICommitOutcome {
  lines: ICommittedLine[];
  levels: ICommittedLevel[];
}

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
    requireDistinctLevels(lines, 'Commit sale');

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
        (result) =>
          result.lines.map((row) => ({
            variantId: row.variantId,
            stockLocationId: row.stockLocationId,
          })),
        { correlationId },
      );
    } catch (error) {
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

  private async commitOnce(
    scope: ITransactionScope,
    orderId: number,
    fulfillmentId: string,
    lines: INormalizedReservationLine[],
    actorId: string | null,
  ): Promise<ICommitOutcome> {
    if (
      await this.movementRepository.existsByReference(
        FULFILLMENT_REFERENCE_TYPE,
        fulfillmentId,
        scope,
      )
    ) {
      throw new LedgerReplayError(FULFILLMENT_REFERENCE_TYPE, fulfillmentId);
    }

    const levels = await loadDistinctLevels(this.repository, lines, scope);

    const computed: { line: INormalizedReservationLine; movement: StockMovement }[] = [];
    const totals = new Map<string, number>();
    for (const line of lines) {
      const key = levelKey(line.variantId, line.stockLocationId);
      const loaded = levels.get(key);
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
          quantity: -line.quantity,
          reasonCode: null,
          referenceType: FULFILLMENT_REFERENCE_TYPE,
          referenceId: fulfillmentId,
          actorId,
        }),
      });
    }

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
