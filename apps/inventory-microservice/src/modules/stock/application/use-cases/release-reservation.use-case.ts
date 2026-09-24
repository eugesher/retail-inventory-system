import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IReservationReleasePayload,
  IReservationReleaseResult,
  ReservationReleaseReason,
  StockMovementTypeEnum,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  ReservationStatusEnum,
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
  OCC_RETRY_ATTEMPTS,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { toReservationView } from './reservation-view.factory';
import { runWithStockWriteRetry } from './stock-mutation';
import { emitReservationReleased, IReleasedReservationRow } from './stock-released.emitter';

const DEFAULT_RELEASE_REASON: ReservationReleaseReason = 'cart-removed';

@Injectable()
export class ReleaseReservationUseCase {
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
    @InjectPinoLogger(ReleaseReservationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IReservationReleasePayload): Promise<IReservationReleaseResult> {
    const { correlationId } = payload;
    const reason = payload.reason ?? DEFAULT_RELEASE_REASON;
    const actorId = payload.actorId ?? null;

    const hasById = payload.reservationId !== undefined && payload.reservationId !== null;
    const hasByCart = payload.cartId !== undefined && payload.cartId !== null;

    this.logger.info(
      {
        correlationId,
        reservationId: payload.reservationId,
        cartId: payload.cartId,
        variantId: payload.variantId,
        stockLocationId: payload.stockLocationId,
        reason,
      },
      'Received RPC: release reservation',
    );

    if (hasById === hasByCart) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_SELECTOR_INVALID,
        'Release requires exactly one selector: either `reservationId` or `cartId` (+ optional variantId/stockLocationId)',
      );
    }

    const targetIds = await this.resolveTargetIds(payload);
    if (targetIds.length === 0) {
      this.logger.info(
        { correlationId, cartId: payload.cartId },
        'Release: no active holds matched — no-op',
      );
      return { released: [] };
    }

    const releasedRows = await this.stockCache.withInvalidation(
      () =>
        runWithStockWriteRetry(
          {
            transactionPort: this.transactionPort,
            logger: this.logger,
            maxAttempts: this.maxAttempts,
          },
          (scope) => this.releaseAll(scope, targetIds, reason, actorId),
          { correlationId },
        ),
      (rows) =>
        rows.map((row) => ({
          variantId: row.reservation.variantId,
          stockLocationId: row.reservation.stockLocationId,
        })),
      { correlationId },
    );

    this.logger.info(
      { correlationId, releasedCount: releasedRows.length, reason },
      'Reservations released — counters returned to available',
    );

    await Promise.all(
      releasedRows.map((row) =>
        emitReservationReleased(this.publisher, this.logger, row, reason, correlationId),
      ),
    );

    return { released: releasedRows.map((row) => toReservationView(row.reservation)) };
  }

  private async resolveTargetIds(payload: IReservationReleasePayload): Promise<string[]> {
    if (payload.reservationId !== undefined && payload.reservationId !== null) {
      const found = await this.reservationRepository.findById(payload.reservationId);
      if (found === null) {
        throw new InventoryDomainException(
          InventoryErrorCodeEnum.RESERVATION_NOT_FOUND,
          `Reservation '${payload.reservationId}' does not exist`,
        );
      }
      if (found.status !== ReservationStatusEnum.ACTIVE) {
        throw new InventoryDomainException(
          InventoryErrorCodeEnum.RESERVATION_INVALID_STATE,
          `Reservation '${payload.reservationId}' is ${found.status}, not active — nothing to release`,
        );
      }
      return found.id === null ? [] : [found.id];
    }

    const cartId = payload.cartId;
    if (cartId === undefined || cartId === null) {
      throw new Error('Release: selector resolution reached the by-cart branch without a cartId');
    }

    const rows =
      payload.variantId !== undefined
        ? await this.reservationRepository.listActiveByCartAndVariant(cartId, payload.variantId)
        : await this.reservationRepository.listActiveByCart(cartId);

    const scoped =
      payload.stockLocationId !== undefined
        ? rows.filter((row) => row.stockLocationId === payload.stockLocationId)
        : rows;

    return scoped.map((row) => row.id).filter((id): id is string => id !== null);
  }

  private async releaseAll(
    scope: ITransactionScope,
    targetIds: string[],
    reason: ReservationReleaseReason,
    actorId: string | null,
  ): Promise<IReleasedReservationRow[]> {
    const released: IReleasedReservationRow[] = [];

    for (const id of targetIds) {
      const row = await this.reservationRepository.findById(id, scope);
      if (row === null) {
        throw new Error(`Release: reservation ${id} vanished mid-transaction`);
      }

      const level = await this.repository.findStockLevel(row.variantId, row.stockLocationId, scope);
      if (level === null) {
        throw new Error(
          `Release: stock level for variant ${row.variantId} @ ${row.stockLocationId} is missing`,
        );
      }

      const expectedVersion = level.version;
      level.releaseReserved(row.quantity);
      row.release();
      await this.repository.persistStockLevelChange(level, expectedVersion, scope);
      const savedRow = await this.reservationRepository.save(row, scope);

      const movement = await this.movementRepository.append(
        StockMovement.record({
          variantId: row.variantId,
          stockLocationId: row.stockLocationId,
          type: StockMovementTypeEnum.RELEASE,
          quantity: -row.quantity,
          reasonCode: reason,
          referenceType: 'cart',
          referenceId: row.cartId,
          actorId,
        }),
        scope,
      );

      released.push({ reservation: savedRow, movement });
    }

    return released;
  }
}
