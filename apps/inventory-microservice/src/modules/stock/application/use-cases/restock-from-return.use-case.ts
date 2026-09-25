import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IRestockFromReturnLine,
  IRestockFromReturnPayload,
  IRestockFromReturnResult,
  IRestockFromReturnResultEntry,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockMovement,
  StockReturnedEvent,
} from '../../domain';
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
import { emitMovementRecorded } from './movement-recorded.emitter';
import { isDuplicateEntryError } from './mysql-error.util';
import {
  INormalizedReservationLine,
  levelKey,
  loadDistinctLevels,
  requireDistinctLevels,
} from './reservation-mutation';
import { runWithStockWriteRetry } from './stock-mutation';

const RETURN_REQUEST_REFERENCE_TYPE = 'return-request';

interface INormalizedRestockLine extends INormalizedReservationLine {
  returnLineId: number;
}

interface IRestockedLine {
  returnLineId: number;
  variantId: number;
  stockLocationId: string;
  quantity: number;
  movement: StockMovement;
}

interface IRestockOutcome {
  lines: IRestockedLine[];
}

function normalizeRestockLines(
  lines: IRestockFromReturnLine[] | undefined,
  label: string,
): INormalizedRestockLine[] {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new InventoryDomainException(
      InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
      `${label} requires a non-empty lines array`,
    );
  }

  return lines.map((line) => {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
        `${label} line quantity must be a positive integer, got ${line.quantity}`,
      );
    }
    return {
      returnLineId: line.returnLineId,
      variantId: line.variantId,
      stockLocationId: line.stockLocationId,
      quantity: line.quantity,
    };
  });
}

@Injectable()
export class RestockFromReturnUseCase {
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
    @InjectPinoLogger(RestockFromReturnUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IRestockFromReturnPayload): Promise<IRestockFromReturnResult> {
    const { returnRequestId, correlationId } = payload;
    const actorId = payload.actorId ?? null;

    this.logger.info(
      { correlationId, returnRequestId, lineCount: payload.lines?.length },
      'Received RPC: restock from return',
    );

    const lines = normalizeRestockLines(payload.lines, 'Restock from return');
    requireDistinctLevels(lines, 'Restock from return');
    const referenceId = String(returnRequestId);

    const alreadyRestocked = await this.movementRepository.existsByReference(
      RETURN_REQUEST_REFERENCE_TYPE,
      referenceId,
    );
    if (alreadyRestocked) {
      this.logger.info(
        { correlationId, returnRequestId },
        'Restock replay — return request already restocked, returning prior result without incrementing',
      );
      return { restocked: lines.map((line) => this.toEntry(line)) };
    }

    let outcome: IRestockOutcome;
    try {
      outcome = await this.stockCache.withInvalidation(
        () =>
          runWithStockWriteRetry(
            {
              transactionPort: this.transactionPort,
              logger: this.logger,
              maxAttempts: this.maxAttempts,
            },
            (scope) => this.restockOnce(scope, returnRequestId, lines, actorId),
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
          { correlationId, returnRequestId },
          'Restock lost a concurrent race — the ledger already holds this return request, nothing incremented',
        );
        return { restocked: lines.map((line) => this.toEntry(line)) };
      }
      throw error;
    }

    this.logger.info(
      { correlationId, returnRequestId, restockedCount: outcome.lines.length },
      'Stock restocked — returned units back on-hand',
    );

    await Promise.all(
      outcome.lines.map((row) => this.emitReturned(row, returnRequestId, correlationId)),
    );

    return { restocked: outcome.lines.map((row) => this.toEntry(row)) };
  }

  private async restockOnce(
    scope: ITransactionScope,
    returnRequestId: number,
    lines: INormalizedRestockLine[],
    actorId: string | null,
  ): Promise<IRestockOutcome> {
    const referenceIdProbe = String(returnRequestId);
    if (
      await this.movementRepository.existsByReference(
        RETURN_REQUEST_REFERENCE_TYPE,
        referenceIdProbe,
        scope,
      )
    ) {
      throw new LedgerReplayError(RETURN_REQUEST_REFERENCE_TYPE, referenceIdProbe);
    }

    const levels = await loadDistinctLevels(this.repository, lines, scope);

    const referenceId = String(returnRequestId);
    const computed: { line: INormalizedRestockLine; movement: StockMovement }[] = [];
    for (const line of lines) {
      const key = levelKey(line.variantId, line.stockLocationId);
      const loaded = levels.get(key);
      if (loaded === undefined) {
        throw new Error(
          `Restock from return: level for ${line.variantId} @ ${line.stockLocationId} not loaded`,
        );
      }
      loaded.level.changeOnHand(line.quantity);

      computed.push({
        line,
        movement: StockMovement.record({
          variantId: line.variantId,
          stockLocationId: line.stockLocationId,
          type: StockMovementTypeEnum.RETURN,
          quantity: line.quantity,
          reasonCode: null,
          referenceType: RETURN_REQUEST_REFERENCE_TYPE,
          referenceId,
          actorId,
        }),
      });
    }

    for (const { level, expectedVersion } of levels.values()) {
      await this.repository.persistStockLevelChange(level, expectedVersion, scope);
    }

    const restockedLines: IRestockedLine[] = [];
    for (const { line, movement } of computed) {
      const appended = await this.movementRepository.append(movement, scope);
      restockedLines.push({
        returnLineId: line.returnLineId,
        variantId: line.variantId,
        stockLocationId: line.stockLocationId,
        quantity: line.quantity,
        movement: appended,
      });
    }

    return { lines: restockedLines };
  }

  private toEntry(line: INormalizedRestockLine | IRestockedLine): IRestockFromReturnResultEntry {
    return {
      returnLineId: line.returnLineId,
      variantId: line.variantId,
      stockLocationId: line.stockLocationId,
      quantity: line.quantity,
    };
  }

  private async emitReturned(
    row: IRestockedLine,
    returnRequestId: number,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishStockReturned(
        new StockReturnedEvent({
          variantId: row.variantId,
          stockLocationId: row.stockLocationId,
          quantity: row.quantity,
          returnRequestId,
          returnLineId: row.returnLineId,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: row.variantId },
        'Failed to publish inventory.stock.returned (restock already committed)',
      );
    }

    await emitMovementRecorded(this.publisher, this.logger, row.movement, correlationId);
  }
}
