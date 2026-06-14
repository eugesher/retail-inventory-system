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
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { reservationExpiresAt } from './reservation-mutation';
import { toReservationView } from './reservation-view.factory';
import { requireActiveLocation } from './stock-location.guard';
import { runWithStockWriteRetry } from './stock-mutation';

// Reserve Stock holds units for a cart against the no-oversell invariant
// (ADR-030). It is **idempotent-by-absolute-quantity** on the all-statuses UNIQUE
// triple `(cartId, variantId, stockLocationId)`: the request carries the absolute
// target quantity, and the use case applies only the *delta* to
// `StockLevel.quantityReserved`, reusing the existing row (refresh / reactivate)
// rather than inserting a second one. The whole read-modify-write runs inside the
// shared bounded optimistic write protocol (`runWithStockWriteRetry`) wrapped in
// `stockCache.withInvalidation` (post-commit invalidation, ADR-023). No
// `StockMovement` is written — a reservation is a hold, not a movement, and the
// ledger's type set has no `reserve` member.
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

    // Backstop for the directly-reachable RMQ path — a typed 400 the filter maps
    // (the domain `StockLevel.reserve` guards the same with a plain Error, but the
    // typed exception gives the caller a clean 4xx instead of a 500).
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
          { transactionPort: this.transactionPort, logger: this.logger },
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

    // Post-commit, best-effort (ADR-020): a publish failure is warn-logged, not
    // raised — the hold already committed.
    await this.emitReserved(saved, view.reservationId, correlationId);

    return view;
  }

  // One attempt of the transactional read-modify-write. Re-reads the level and the
  // hold fresh under the scope so a retried attempt never double-applies (a failed
  // attempt's in-memory mutations are discarded; the next read returns the stored
  // state). Returns the saved `Reservation` so `withInvalidation` can resolve the
  // `(variantId, stockLocationId)` to wipe.
  private async reserveOnce(
    scope: ITransactionScope,
    variantId: number,
    stockLocationId: string,
    quantity: number,
    cartId: string,
  ): Promise<Reservation> {
    const existing = await this.repository.findStockLevel(variantId, stockLocationId, scope);
    // Capture the optimistic token BEFORE any mutation bumps it; null marks a
    // first-touch INSERT of the level.
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
      // First hold for the triple: reserve the full quantity and mint a new row.
      level.reserve(quantity);
      reservation = Reservation.create({ variantId, stockLocationId, quantity, cartId, expiresAt });
      counterMoved = true;
    } else if (held.status === ReservationStatusEnum.ACTIVE) {
      // Idempotent re-reserve: move the counter only by the delta to the new
      // absolute quantity, then refresh the hold (Q9 refresh-on-write).
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
      // Row reuse: a previously removed/lapsed line is re-added — reserve the full
      // quantity (the row holds nothing in the counter while released) and flip it
      // back to active.
      level.reserve(quantity);
      held.reactivate(quantity, expiresAt);
      reservation = held;
      counterMoved = true;
    } else {
      // committed — a converted cart is frozen retail-side, so this is
      // defense-in-depth.
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_INVALID_STATE,
        `Reserve: hold ${held.id ?? '<new>'} for cart ${cartId} is committed and cannot be re-reserved`,
      );
    }

    // Persist the level only when a counter actually moved — a delta-zero
    // re-reserve refreshes the TTL but leaves the counters untouched, so a
    // version-checked UPDATE would be wasted work.
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
