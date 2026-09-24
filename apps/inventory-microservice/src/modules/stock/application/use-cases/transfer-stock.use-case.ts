import { randomUUID } from 'crypto';

import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IStockTransferPayload,
  IStockTransferResult,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  StockLevel,
  StockMovement,
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
import { maybeEmitLowStock } from './low-stock.emitter';
import { emitMovementRecorded } from './movement-recorded.emitter';
import { requireActiveLocation } from './stock-location.guard';
import { runWithStockWriteRetry } from './stock-mutation';
import { toStockLevelView } from './stock-view.factory';

interface ITransferred {
  source: StockLevel;
  destination: StockLevel;
  outMovement: StockMovement;
  inMovement: StockMovement;
}

@Injectable()
export class TransferStockUseCase {
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
    @InjectPinoLogger(TransferStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IStockTransferPayload): Promise<IStockTransferResult> {
    const { variantId, fromLocationId, toLocationId, quantity, actorId, correlationId } = payload;

    this.logger.info(
      { correlationId, variantId, fromLocationId, toLocationId, quantity, actorId },
      'Received RPC: transfer stock',
    );

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.TRANSFER_QUANTITY_INVALID,
        `Transfer quantity must be a positive integer, got ${quantity}`,
      );
    }
    if (fromLocationId === toLocationId) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.TRANSFER_SAME_LOCATION,
        `Transfer source and destination must differ, both were '${fromLocationId}'`,
      );
    }

    await requireActiveLocation(this.repository, fromLocationId);
    await requireActiveLocation(this.repository, toLocationId);

    const transferId = randomUUID();

    const transferred = await this.stockCache.withInvalidation(
      () =>
        runWithStockWriteRetry(
          {
            transactionPort: this.transactionPort,
            logger: this.logger,
            maxAttempts: this.maxAttempts,
          },
          (scope) =>
            this.transferOnce(scope, variantId, fromLocationId, toLocationId, quantity, {
              transferId,
              actorId: actorId ?? null,
            }),
          { variantId, correlationId },
        ),
      (result) => [
        { variantId, stockLocationId: result.source.stockLocationId },
        { variantId, stockLocationId: result.destination.stockLocationId },
      ],
      { correlationId },
    );

    this.logger.info(
      {
        correlationId,
        variantId,
        fromLocationId,
        toLocationId,
        quantity,
        transferId,
        sourceOnHand: transferred.source.quantityOnHand,
        destinationOnHand: transferred.destination.quantityOnHand,
      },
      'Stock transferred — on-hand moved between locations',
    );

    await Promise.all([
      emitMovementRecorded(this.publisher, this.logger, transferred.outMovement, correlationId),
      emitMovementRecorded(this.publisher, this.logger, transferred.inMovement, correlationId),
      maybeEmitLowStock(this.publisher, this.logger, transferred.source, -quantity, correlationId),
    ]);

    return {
      from: toStockLevelView(transferred.source),
      to: toStockLevelView(transferred.destination),
    };
  }

  private async transferOnce(
    scope: ITransactionScope,
    variantId: number,
    fromLocationId: string,
    toLocationId: string,
    quantity: number,
    ledger: { transferId: string; actorId: string | null },
  ): Promise<ITransferred> {
    const existingSource = await this.repository.findStockLevel(variantId, fromLocationId, scope);
    const sourceExpectedVersion = existingSource ? existingSource.version : null;
    const source = existingSource ?? StockLevel.initialAt(variantId, fromLocationId);
    source.changeOnHand(-quantity);

    const existingDestination = await this.repository.findStockLevel(
      variantId,
      toLocationId,
      scope,
    );
    const destinationExpectedVersion = existingDestination ? existingDestination.version : null;
    const destination = existingDestination ?? StockLevel.initialAt(variantId, toLocationId);
    destination.changeOnHand(quantity);

    const savedSource = await this.repository.persistStockLevelChange(
      source,
      sourceExpectedVersion,
      scope,
    );
    const savedDestination = await this.repository.persistStockLevelChange(
      destination,
      destinationExpectedVersion,
      scope,
    );

    const outMovement = await this.movementRepository.append(
      StockMovement.record({
        variantId,
        stockLocationId: fromLocationId,
        type: StockMovementTypeEnum.ADJUSTMENT,
        quantity: -quantity,
        reasonCode: 'transfer-out',
        referenceType: 'transfer',
        referenceId: ledger.transferId,
        actorId: ledger.actorId,
      }),
      scope,
    );
    const inMovement = await this.movementRepository.append(
      StockMovement.record({
        variantId,
        stockLocationId: toLocationId,
        type: StockMovementTypeEnum.ADJUSTMENT,
        quantity,
        reasonCode: 'transfer-in',
        referenceType: 'transfer',
        referenceId: ledger.transferId,
        actorId: ledger.actorId,
      }),
      scope,
    );

    return { source: savedSource, destination: savedDestination, outMovement, inMovement };
  }
}
