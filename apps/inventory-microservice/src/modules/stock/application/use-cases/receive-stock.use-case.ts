import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IStockReceivePayload,
  StockLevelView,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockLevel,
  StockMovement,
  StockReceivedEvent,
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
import { emitMovementRecorded } from './movement-recorded.emitter';
import { applyOnHandChange } from './stock-mutation';
import { requireActiveLocation } from './stock-location.guard';
import { toStockLevelView } from './stock-view.factory';

@Injectable()
export class ReceiveStockUseCase {
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
    @InjectPinoLogger(ReceiveStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IStockReceivePayload): Promise<StockLevelView> {
    const { variantId, quantity, actorId, correlationId } = payload;
    const stockLocationId = payload.stockLocationId ?? INVENTORY_DEFAULT_STOCK_LOCATION;

    this.logger.info(
      { correlationId, variantId, stockLocationId, quantity, actorId },
      'Received RPC: receive stock',
    );

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.STOCK_RECEIVE_QUANTITY_INVALID,
        `Receive quantity must be a positive integer, got ${quantity}`,
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
        delta: quantity,
        correlationId,
        buildMovement: (persisted) =>
          StockMovement.record({
            variantId: persisted.variantId,
            stockLocationId: persisted.stockLocationId,
            type: StockMovementTypeEnum.RECEIPT,
            quantity,
            reasonCode: null,
            referenceType: null,
            referenceId: null,
            actorId: actorId ?? null,
          }),
      },
    );

    this.logger.info(
      { correlationId, variantId, stockLocationId, newOnHand: saved.quantityOnHand },
      'Stock received — on-hand raised',
    );

    await Promise.all([
      this.emitReceived(saved, quantity, actorId, correlationId),
      emitMovementRecorded(this.publisher, this.logger, movement, correlationId),
    ]);

    return toStockLevelView(saved);
  }

  private async emitReceived(
    saved: StockLevel,
    quantityDelta: number,
    actorId?: string,
    correlationId?: string,
  ): Promise<void> {
    try {
      await this.publisher.publishStockReceived(
        new StockReceivedEvent({
          variantId: saved.variantId,
          stockLocationId: saved.stockLocationId,
          quantityDelta,
          newOnHand: saved.quantityOnHand,
          actorId,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: saved.variantId },
        'Failed to publish inventory.stock.received (write already committed)',
      );
    }
  }
}
