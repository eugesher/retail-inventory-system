import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IAllocationCancelPayload,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockMovement,
  StockReleasedEvent,
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
import { emitMovementRecorded } from './movement-recorded.emitter';
import { isDuplicateEntryError } from './mysql-error.util';
import {
  INormalizedReservationLine,
  levelKey,
  loadDistinctLevels,
  normalizeReservationLines,
} from './reservation-mutation';
import { runWithStockWriteRetry } from './stock-mutation';

const DEFAULT_CANCEL_REASON = 'order-cancelled';

const CANCEL_EVENT_REASON = 'order-cancelled' as const;

interface ICancelledLine {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  movement: StockMovement;
}

@Injectable()
export class CancelAllocationUseCase {
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
    @InjectPinoLogger(CancelAllocationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IAllocationCancelPayload): Promise<{ cancelled: number }> {
    const { orderId, correlationId } = payload;
    const reasonCode = payload.reason ?? DEFAULT_CANCEL_REASON;
    const actorId = payload.actorId ?? null;

    this.logger.info(
      { correlationId, orderId, lineCount: payload.lines?.length, reasonCode },
      'Received RPC: cancel allocation',
    );

    const lines = normalizeReservationLines(payload.lines, 'Cancel allocation');
    const operationKey = payload.operationKey?.trim();
    if (!operationKey) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
        'Cancel allocation requires an operationKey — the identity that makes a redelivery recognisable',
      );
    }

    let cancelled: ICancelledLine[];
    try {
      cancelled = await this.stockCache.withInvalidation(
        () =>
          runWithStockWriteRetry(
            {
              transactionPort: this.transactionPort,
              logger: this.logger,
              maxAttempts: this.maxAttempts,
            },
            (scope) => this.cancelOnce(scope, orderId, lines, reasonCode, actorId, operationKey),
            { correlationId },
          ),
        (rows) =>
          rows.map((row) => ({ variantId: row.variantId, stockLocationId: row.stockLocationId })),
        { correlationId },
      );
    } catch (error) {
      if (isDuplicateEntryError(error)) {
        this.logger.info(
          { correlationId, orderId, operationKey },
          'Cancel allocation replay — this cancellation is already in the ledger, nothing released',
        );
        return { cancelled: lines.length };
      }
      throw error;
    }

    this.logger.info(
      { correlationId, orderId, cancelledCount: cancelled.length },
      'Allocation cancelled — units returned to available',
    );

    await Promise.all(cancelled.map((row) => this.emitReleased(row, correlationId)));

    return { cancelled: cancelled.length };
  }

  private async cancelOnce(
    scope: ITransactionScope,
    orderId: number,
    lines: INormalizedReservationLine[],
    reasonCode: string,
    actorId: string | null,
    operationKey: string,
  ): Promise<ICancelledLine[]> {
    const levels = await loadDistinctLevels(this.repository, lines, scope);

    const computed: { line: INormalizedReservationLine; movement: StockMovement }[] = [];
    for (const line of lines) {
      const loaded = levels.get(levelKey(line.variantId, line.stockLocationId));
      if (loaded === undefined) {
        throw new Error(`Cancel: level for ${line.variantId} @ ${line.stockLocationId} not loaded`);
      }
      loaded.level.releaseAllocated(line.quantity);

      computed.push({
        line,
        movement: StockMovement.record({
          variantId: line.variantId,
          stockLocationId: line.stockLocationId,
          type: StockMovementTypeEnum.RELEASE,
          quantity: -line.quantity,
          reasonCode,
          referenceType: 'order',
          referenceId: String(orderId),
          actorId,
          operationKey,
        }),
      });
    }

    for (const { level, expectedVersion } of levels.values()) {
      await this.repository.persistStockLevelChange(level, expectedVersion, scope);
    }

    const cancelled: ICancelledLine[] = [];
    for (const { line, movement } of computed) {
      const appended = await this.movementRepository.append(movement, scope);
      cancelled.push({
        variantId: line.variantId,
        stockLocationId: line.stockLocationId,
        quantity: line.quantity,
        movement: appended,
      });
    }

    return cancelled;
  }

  private async emitReleased(row: ICancelledLine, correlationId: string): Promise<void> {
    try {
      await this.publisher.publishStockReleased(
        new StockReleasedEvent({
          variantId: row.variantId,
          stockLocationId: row.stockLocationId,
          quantity: row.quantity,
          cartId: null,
          reservationId: null,
          reason: CANCEL_EVENT_REASON,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: row.variantId },
        'Failed to publish inventory.stock.released (cancel already committed)',
      );
    }

    await emitMovementRecorded(this.publisher, this.logger, row.movement, correlationId);
  }
}
