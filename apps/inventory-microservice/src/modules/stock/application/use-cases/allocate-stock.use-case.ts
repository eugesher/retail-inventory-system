import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IAllocationResult,
  IAllocationResultEntry,
  IReservationAllocatePayload,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  Reservation,
  ReservationStatusEnum,
  StockAllocatedEvent,
  StockLevel,
  StockMovement,
} from '../../domain';
import {
  IReservationRepositoryPort,
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  ITransactionPort,
  ITransactionScope,
  RESERVATION_REPOSITORY,
  RESERVATION_TTL_MINUTES,
  OCC_RETRY_ATTEMPTS,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { emitMovementRecorded } from './movement-recorded.emitter';
import {
  INormalizedReservationLine,
  levelKey,
  loadDistinctLevels,
  normalizeReservationLines,
  reservationExpiresAt,
} from './reservation-mutation';
import { runWithStockWriteRetry } from './stock-mutation';

interface IAllocatedLine {
  entry: IAllocationResultEntry;
  movement: StockMovement;
}

@Injectable()
export class AllocateStockUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(RESERVATION_REPOSITORY)
    private readonly reservationRepository: IReservationRepositoryPort,
    @Inject(STOCK_MOVEMENT_REPOSITORY)
    private readonly movementRepository: IStockMovementRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @Inject(STOCK_EVENTS_PUBLISHER)
    private readonly publisher: IStockEventsPublisherPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @Inject(RESERVATION_TTL_MINUTES)
    private readonly ttlMinutes: number,
    @InjectPinoLogger(AllocateStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IReservationAllocatePayload): Promise<IAllocationResult> {
    const { cartId, orderId, correlationId } = payload;

    this.logger.info(
      { correlationId, cartId, orderId, lineCount: payload.lines?.length },
      'Received RPC: allocate stock',
    );

    const lines = normalizeReservationLines(payload.lines, 'Allocate');

    const allocated = await this.stockCache.withInvalidation(
      () =>
        runWithStockWriteRetry(
          {
            transactionPort: this.transactionPort,
            logger: this.logger,
            maxAttempts: this.maxAttempts,
          },
          (scope) => this.allocateOnce(scope, cartId, orderId, lines),
          { correlationId },
        ),
      (rows) =>
        rows.map((row) => ({
          variantId: row.entry.variantId,
          stockLocationId: row.entry.stockLocationId,
        })),
      { correlationId },
    );

    this.logger.info(
      { correlationId, cartId, orderId, allocatedCount: allocated.length },
      'Stock allocated — order holds committed',
    );

    await Promise.all(allocated.map((row) => this.emitAllocated(row, orderId, correlationId)));

    return { allocated: allocated.map((row) => row.entry) };
  }

  private async allocateOnce(
    scope: ITransactionScope,
    cartId: string,
    orderId: number,
    lines: INormalizedReservationLine[],
  ): Promise<IAllocatedLine[]> {
    const now = new Date();
    const expiresAt = reservationExpiresAt(now, this.ttlMinutes);

    const levels = await loadDistinctLevels(this.repository, lines, scope);

    const computed: { entry: IAllocationResultEntry; movement: StockMovement }[] = [];
    const reservationsToSave: Reservation[] = [];

    for (const line of lines) {
      const loaded = levels.get(levelKey(line.variantId, line.stockLocationId));
      if (loaded === undefined) {
        throw new Error(
          `Allocate: level for ${line.variantId} @ ${line.stockLocationId} not loaded`,
        );
      }
      const { level } = loaded;

      const held = await this.reservationRepository.findByKey(
        cartId,
        line.variantId,
        line.stockLocationId,
        scope,
      );

      const reservationId = this.applyLineCounters(level, held, line, now, expiresAt);
      if (held !== null && reservationId !== null) {
        reservationsToSave.push(held);
      }

      computed.push({
        entry: {
          variantId: line.variantId,
          stockLocationId: line.stockLocationId,
          quantity: line.quantity,
          reservationId,
        },
        movement: StockMovement.record({
          variantId: line.variantId,
          stockLocationId: line.stockLocationId,
          type: StockMovementTypeEnum.ALLOCATION,
          quantity: -line.quantity,
          reasonCode: null,
          referenceType: 'order',
          referenceId: String(orderId),
          actorId: null,
        }),
      });
    }

    for (const { level, expectedVersion } of levels.values()) {
      await this.repository.persistStockLevelChange(level, expectedVersion, scope);
    }
    for (const reservation of reservationsToSave) {
      await this.reservationRepository.save(reservation, scope);
    }

    const allocated: IAllocatedLine[] = [];
    for (const row of computed) {
      const movement = await this.movementRepository.append(row.movement, scope);
      allocated.push({ entry: row.entry, movement });
    }

    return allocated;
  }

  private applyLineCounters(
    level: StockLevel,
    held: Reservation | null,
    line: INormalizedReservationLine,
    now: Date,
    expiresAt: Date,
  ): string | null {
    if (held?.status !== ReservationStatusEnum.ACTIVE) {
      if (held !== null && held.status === ReservationStatusEnum.COMMITTED) {
        throw new InventoryDomainException(
          InventoryErrorCodeEnum.RESERVATION_INVALID_STATE,
          `Allocate: hold ${held.id ?? '<unknown>'} for cart ${held.cartId} is already committed`,
        );
      }
      level.allocateDirect(line.quantity);
      return null;
    }

    if (held.isExpired(now)) {
      held.refresh(held.quantity, expiresAt);
    }
    held.commit(now);

    if (held.quantity === line.quantity) {
      level.allocateFromReserved(line.quantity);
    } else {
      level.releaseReserved(held.quantity);
      level.allocateDirect(line.quantity);
    }

    return held.id;
  }

  private async emitAllocated(
    row: IAllocatedLine,
    orderId: number,
    correlationId: string,
  ): Promise<void> {
    const { entry, movement } = row;

    try {
      await this.publisher.publishStockAllocated(
        new StockAllocatedEvent({
          variantId: entry.variantId,
          stockLocationId: entry.stockLocationId,
          quantity: entry.quantity,
          orderId,
          reservationId: entry.reservationId,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: entry.variantId },
        'Failed to publish inventory.stock.allocated (allocation already committed)',
      );
    }

    await emitMovementRecorded(this.publisher, this.logger, movement, correlationId);
  }
}
