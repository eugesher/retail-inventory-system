import { randomUUID } from 'crypto';

import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IReservationSweepResult,
  ReservationReleaseReason,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import { ReservationStatusEnum, StockMovement } from '../../domain';
import {
  IReservationRepositoryPort,
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockMovementRepositoryPort,
  IStockRepositoryPort,
  ITransactionPort,
  ITransactionScope,
  OCC_RETRY_ATTEMPTS,
  RESERVATION_REPOSITORY,
  RESERVATION_SWEEP_BATCH_SIZE,
  RESERVATION_SWEEP_TRANSACTION_SIZE,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { runWithStockWriteRetry } from './stock-mutation';
import { emitReservationReleased, IReleasedReservationRow } from './stock-released.emitter';

const EXPIRY_RELEASE_REASON: ReservationReleaseReason = 'expired';

export interface ISweepExpiredReservationsParams {
  batchSize?: number;
  correlationId?: string;
  actorId?: string | null;
}

interface IExpiredChunk {
  rows: IReleasedReservationRow[];
  skipped: number;
}

@Injectable()
export class SweepExpiredReservationsUseCase {
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
    @Inject(RESERVATION_SWEEP_BATCH_SIZE)
    private readonly configuredBatchSize: number,
    @Inject(RESERVATION_SWEEP_TRANSACTION_SIZE)
    private readonly transactionSize: number,
    @InjectPinoLogger(SweepExpiredReservationsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    params: ISweepExpiredReservationsParams = {},
  ): Promise<IReservationSweepResult> {
    const startedAt = Date.now();
    const now = new Date();
    const correlationId = params.correlationId ?? randomUUID();
    const actorId = params.actorId ?? null;
    const limit = this.resolveLimit(params.batchSize);

    const candidates = await this.reservationRepository.listExpiredActive(now, limit);
    const scanned = candidates.length;

    if (scanned === 0) {
      this.logger.debug(
        { correlationId, now: now.toISOString() },
        'Reservation sweep: nothing expired',
      );
      return { scanned: 0, expired: 0, skipped: 0, durationMs: Date.now() - startedAt };
    }

    const ids = candidates.map((row) => row.id).filter((id): id is string => id !== null);
    let expired = 0;
    let skipped = scanned - ids.length;
    let batches = 0;

    for (const chunk of chunkIds(ids, this.transactionSize)) {
      const outcome = await this.stockCache.withInvalidation(
        () =>
          runWithStockWriteRetry(
            {
              transactionPort: this.transactionPort,
              logger: this.logger,
              maxAttempts: this.maxAttempts,
            },
            (scope) => this.expireChunk(scope, chunk, now, actorId),
            { correlationId },
          ),
        (result) =>
          result.rows.map((row) => ({
            variantId: row.reservation.variantId,
            stockLocationId: row.reservation.stockLocationId,
          })),
        { correlationId },
      );

      expired += outcome.rows.length;
      skipped += outcome.skipped;
      batches += 1;

      await Promise.all(
        outcome.rows.map((row) =>
          emitReservationReleased(
            this.publisher,
            this.logger,
            row,
            EXPIRY_RELEASE_REASON,
            correlationId,
          ),
        ),
      );
    }

    const result: IReservationSweepResult = {
      scanned,
      expired,
      skipped,
      durationMs: Date.now() - startedAt,
    };

    const line = { correlationId, ...result, batches };
    if (expired > 0) {
      this.logger.info(line, 'Reservation sweep completed');
    } else {
      this.logger.debug(line, 'Reservation sweep completed — every candidate was skipped');
    }

    return result;
  }

  private resolveLimit(requested?: number): number {
    if (typeof requested !== 'number' || !Number.isFinite(requested)) {
      return this.configuredBatchSize;
    }
    return Math.min(Math.max(Math.trunc(requested), 1), this.configuredBatchSize);
  }

  private async expireChunk(
    scope: ITransactionScope,
    ids: string[],
    now: Date,
    actorId: string | null,
  ): Promise<IExpiredChunk> {
    const rows: IReleasedReservationRow[] = [];
    let skipped = 0;

    for (const id of ids) {
      const row = await this.reservationRepository.findById(id, scope);

      if (row === null) {
        skipped += 1;
        continue;
      }

      if (row.status !== ReservationStatusEnum.ACTIVE) {
        skipped += 1;
        continue;
      }

      if (!row.isExpired(now)) {
        skipped += 1;
        continue;
      }

      const level = await this.repository.findStockLevel(row.variantId, row.stockLocationId, scope);
      if (level === null) {
        throw new Error(
          `Sweep: stock level for variant ${row.variantId} @ ${row.stockLocationId} is missing`,
        );
      }

      const expectedVersion = level.version;
      level.releaseReserved(row.quantity);
      row.expire();
      await this.repository.persistStockLevelChange(level, expectedVersion, scope);
      const savedRow = await this.reservationRepository.save(row, scope);

      const movement = await this.movementRepository.append(
        StockMovement.record({
          variantId: row.variantId,
          stockLocationId: row.stockLocationId,
          type: StockMovementTypeEnum.RELEASE,
          quantity: -row.quantity,
          reasonCode: EXPIRY_RELEASE_REASON,
          referenceType: 'cart',
          referenceId: row.cartId,
          actorId,
        }),
        scope,
      );

      rows.push({ reservation: savedRow, movement });
    }

    return { rows, skipped };
  }
}

function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size));
  }
  return chunks;
}
