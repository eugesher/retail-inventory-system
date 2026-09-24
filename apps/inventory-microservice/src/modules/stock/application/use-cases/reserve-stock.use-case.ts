import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_STOCK_LOCATION,
  IReservationReservePayload,
  ReservationView,
} from '@retail-inventory-system/contracts';

import {
  InventoryDomainException,
  InventoryErrorCodeEnum,
  Reservation,
  ReservationStatusEnum,
  StockLevel,
  StockReservedEvent,
} from '../../domain';
import {
  IReservationRepositoryPort,
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockRepositoryPort,
  ITransactionPort,
  ITransactionScope,
  RESERVATION_REPOSITORY,
  RESERVATION_TTL_MINUTES,
  OCC_RETRY_ATTEMPTS,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { reservationExpiresAt } from './reservation-mutation';
import { toReservationView } from './reservation-view.factory';
import { requireActiveLocation } from './stock-location.guard';
import { runWithStockWriteRetry } from './stock-mutation';

@Injectable()
export class ReserveStockUseCase {
  constructor(
    @Inject(TRANSACTION_PORT)
    private readonly transactionPort: ITransactionPort,
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(RESERVATION_REPOSITORY)
    private readonly reservationRepository: IReservationRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @Inject(STOCK_EVENTS_PUBLISHER)
    private readonly publisher: IStockEventsPublisherPort,
    @Inject(OCC_RETRY_ATTEMPTS)
    private readonly maxAttempts: number,
    @Inject(RESERVATION_TTL_MINUTES)
    private readonly ttlMinutes: number,
    @InjectPinoLogger(ReserveStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IReservationReservePayload): Promise<ReservationView> {
    const { variantId, quantity, cartId, correlationId } = payload;
    const stockLocationId = payload.stockLocationId ?? INVENTORY_DEFAULT_STOCK_LOCATION;

    this.logger.info(
      { correlationId, variantId, stockLocationId, quantity, cartId },
      'Received RPC: reserve stock',
    );

    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID,
        `Reserve quantity must be a positive integer, got ${quantity}`,
      );
    }

    await requireActiveLocation(this.repository, stockLocationId);

    const saved = await this.stockCache.withInvalidation(
      () =>
        runWithStockWriteRetry(
          {
            transactionPort: this.transactionPort,
            logger: this.logger,
            maxAttempts: this.maxAttempts,
          },
          (scope) => this.reserveOnce(scope, variantId, stockLocationId, quantity, cartId),
          { variantId, stockLocationId, correlationId },
        ),
      (reservation) => [
        { variantId: reservation.variantId, stockLocationId: reservation.stockLocationId },
      ],
      { correlationId },
    );

    const view = toReservationView(saved);

    this.logger.info(
      { correlationId, variantId, stockLocationId, reservationId: view.reservationId, quantity },
      'Stock reserved — hold persisted',
    );

    await this.emitReserved(saved, view.reservationId, correlationId);

    return view;
  }

  private async reserveOnce(
    scope: ITransactionScope,
    variantId: number,
    stockLocationId: string,
    quantity: number,
    cartId: string,
  ): Promise<Reservation> {
    const existing = await this.repository.findStockLevel(variantId, stockLocationId, scope);
    const expectedVersion = existing ? existing.version : null;
    const level = existing ?? StockLevel.initialAt(variantId, stockLocationId);

    const held = await this.reservationRepository.findByKey(
      cartId,
      variantId,
      stockLocationId,
      scope,
    );
    const expiresAt = reservationExpiresAt(new Date(), this.ttlMinutes);

    let reservation: Reservation;
    let counterMoved = false;

    if (held === null) {
      level.reserve(quantity);
      reservation = Reservation.create({ variantId, stockLocationId, quantity, cartId, expiresAt });
      counterMoved = true;
    } else if (held.status === ReservationStatusEnum.ACTIVE) {
      const delta = quantity - held.quantity;
      if (delta > 0) {
        level.reserve(delta);
        counterMoved = true;
      } else if (delta < 0) {
        level.releaseReserved(-delta);
        counterMoved = true;
      }
      held.refresh(quantity, expiresAt);
      reservation = held;
    } else if (
      held.status === ReservationStatusEnum.RELEASED ||
      held.status === ReservationStatusEnum.EXPIRED
    ) {
      level.reserve(quantity);
      held.reactivate(quantity, expiresAt);
      reservation = held;
      counterMoved = true;
    } else {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_INVALID_STATE,
        `Reserve: hold ${held.id ?? '<new>'} for cart ${cartId} is committed and cannot be re-reserved`,
      );
    }

    if (counterMoved) {
      await this.repository.persistStockLevelChange(level, expectedVersion, scope);
    }

    return this.reservationRepository.save(reservation, scope);
  }

  private async emitReserved(
    reservation: Reservation,
    reservationId: string,
    correlationId: string,
  ): Promise<void> {
    try {
      await this.publisher.publishStockReserved(
        new StockReservedEvent({
          variantId: reservation.variantId,
          stockLocationId: reservation.stockLocationId,
          quantity: reservation.quantity,
          cartId: reservation.cartId,
          reservationId,
          expiresAt: reservation.expiresAt,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: reservation.variantId },
        'Failed to publish inventory.stock.reserved (hold already committed)',
      );
    }
  }
}
