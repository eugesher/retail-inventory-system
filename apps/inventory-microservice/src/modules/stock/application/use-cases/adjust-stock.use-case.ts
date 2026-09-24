import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IStockAdjustPayload,
  StockLevelView,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockAdjustedEvent,
  StockLevel,
  StockMovement,
} from '../../domain';
import {
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  ITransactionPort,
  OCC_RETRY_ATTEMPTS,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { maybeEmitLowStock } from './low-stock.emitter';
import { emitMovementRecorded } from './movement-recorded.emitter';
import { applyOnHandChange } from './stock-mutation';
import { requireActiveLocation } from './stock-location.guard';
import { toStockLevelView } from './stock-view.factory';

@Injectable()
export class AdjustStockUseCase {
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
    @InjectPinoLogger(AdjustStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IStockAdjustPayload): Promise<StockLevelView> {
    const { variantId, quantityDelta, reasonCode, actorId, correlationId } = payload;
    const stockLocationId = payload.stockLocationId ?? INVENTORY_DEFAULT_STOCK_LOCATION;

    this.logger.info(
      { correlationId, variantId, stockLocationId, quantityDelta, reasonCode, actorId },
      'Received RPC: adjust stock',
    );

    if (!Number.isInteger(quantityDelta) || quantityDelta === 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_ADJUSTMENT_DELTA_INVALID,
        `Adjustment delta must be a non-zero integer, got ${quantityDelta}`,
      );
    }
    if (typeof reasonCode !== 'string' || reasonCode.trim().length === 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_ADJUSTMENT_REASON_REQUIRED,
        'Adjustment reasonCode is mandatory and must be a non-empty string',
      );
    }

    await requireActiveLocation(this.repository, stockLocationId);

    const { level: saved, movement } = await applyOnHandChange(
      {
        transactionPort: this.transactionPort,
        repository: this.repository,
        movementRepository: this.movementRepository,
        stockCache: this.stockCache,
        logger: this.logger,
        maxAttempts: this.maxAttempts,
      },
      {
        variantId,
        stockLocationId,
        delta: quantityDelta,
        correlationId,
        buildMovement: (persisted) =>
          StockMovement.record({
            variantId: persisted.variantId,
            stockLocationId: persisted.stockLocationId,
            type: StockMovementTypeEnum.ADJUSTMENT,
            quantity: quantityDelta,
            reasonCode,
            referenceType: null,
            referenceId: null,
            actorId: actorId ?? null,
          }),
      },
    );

    this.logger.info(
      { correlationId, variantId, stockLocationId, quantityDelta, newOnHand: saved.quantityOnHand },
      'Stock adjusted — signed delta applied',
    );

    await Promise.all([
      this.emitAdjusted(saved, quantityDelta, reasonCode, actorId, correlationId),
      maybeEmitLowStock(this.publisher, this.logger, saved, quantityDelta, correlationId),
      emitMovementRecorded(this.publisher, this.logger, movement, correlationId),
    ]);

    return toStockLevelView(saved);
  }

  private async emitAdjusted(
    saved: StockLevel,
    quantityDelta: number,
    reasonCode: string,
    actorId?: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.publisher.publishStockAdjusted(
        new StockAdjustedEvent({
          variantId: saved.variantId,
          stockLocationId: saved.stockLocationId,
          quantityDelta,
          reasonCode,
          newOnHand: saved.quantityOnHand,
          actorId,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: saved.variantId },
        'Failed to publish inventory.stock.adjusted (write already committed)',
      );
    }
  }
}
