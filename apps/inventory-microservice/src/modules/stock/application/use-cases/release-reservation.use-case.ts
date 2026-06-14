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
  Reservation,
  ReservationStatusEnum,
  StockMovement,
  StockReleasedEvent,
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
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_MOVEMENT_REPOSITORY,
  STOCK_REPOSITORY,
  TRANSACTION_PORT,
} from '../ports';
import { emitMovementRecorded } from './movement-recorded.emitter';
import { toReservationView } from './reservation-view.factory';
import { runWithStockWriteRetry } from './stock-mutation';

const DEFAULT_RELEASE_REASON: ReservationReleaseReason = 'cart-removed';

// One released hold + the ledger row that records it, carried out of the
// transaction so the post-commit emits can fire per row.
interface IReleasedRow {
  reservation: Reservation;
  movement: StockMovement;
}

// Release Reservation returns held units to `available` and leaves an audit trail
// (ADR-030 §4). It accepts EXACTLY one selector family — `reservationId` (one row)
// or `cartId` (+ optional `variantId` / `stockLocationId`, all matching active
// rows) — rejecting both/neither with `RESERVATION_SELECTOR_INVALID`. The by-id
// path 404s on an unknown id and 409s a non-active hold; the by-cart path treats
// an empty match as an idempotent no-op. The matched rows are released atomically
// inside one `withInvalidation(runWithStockWriteRetry(...))`: per row it loads the
// `StockLevel`, `releaseReserved`s the held quantity, flips the row to `released`,
// version-checked-persists the level, saves the row, and appends a **negative
// `release` movement** (`referenceType 'cart'`). Released + movement-recorded
// events fire post-commit, best-effort.
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

    // Exactly one selector family — both present or neither is a 400.
    if (hasById === hasByCart) {
      throw new InventoryDomainException(
        InventoryErrorCodeEnum.RESERVATION_SELECTOR_INVALID,
        'Release requires exactly one selector: either `reservationId` or `cartId` (+ optional variantId/stockLocationId)',
      );
    }

    // Resolve which holds to release (a pre-tx read that decides the 404 / empty
    // no-op). The transaction re-reads each by id, so a retry never operates on a
    // stale in-memory row.
    const targetIds = await this.resolveTargetIds(payload);
    if (targetIds.length === 0) {
      // Selector B with no active match — idempotent no-op (remove-after-remove
      // must not error). Selector A would have 404'd above instead.
      this.logger.info(
        { correlationId, cartId: payload.cartId },
        'Release: no active holds matched — no-op',
      );
      return { released: [] };
    }

    const releasedRows = await this.stockCache.withInvalidation(
      () =>
        runWithStockWriteRetry(
          { transactionPort: this.transactionPort, logger: this.logger },
          (scope) => this.releaseAll(scope, targetIds, reason, actorId),
          { correlationId },
        ),
      // `withInvalidation` dedupes by variantId and wipes a per-variant prefix
      // covering every location facet, so the raw per-row items are enough.
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

    // Post-commit, best-effort (ADR-020), per released row.
    await Promise.all(releasedRows.map((row) => this.emitReleased(row, reason, correlationId)));

    return { released: releasedRows.map((row) => toReservationView(row.reservation)) };
  }

  // The by-id selector resolves to a single id (404 missing, 409 non-active); the
  // by-cart selector resolves to all matching active ids (an empty list is the
  // no-op the caller returns early on).
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
      // Unreachable: the selector check guarantees a cartId on this branch.
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

  // One transactional attempt: release every matched hold atomically. Re-reads
  // each reservation + its level fresh under the scope so a retried attempt never
  // double-applies. Each release writes one negative `release` movement.
  private async releaseAll(
    scope: ITransactionScope,
    targetIds: string[],
    reason: ReservationReleaseReason,
    actorId: string | null,
  ): Promise<IReleasedRow[]> {
    const released: IReleasedRow[] = [];

    for (const id of targetIds) {
      const row = await this.reservationRepository.findById(id, scope);
      if (row === null) {
        // Resolved present pre-tx; a vanished row is an invariant breach (FKs are
        // ON DELETE RESTRICT), not a client error.
        throw new Error(`Release: reservation ${id} vanished mid-transaction`);
      }

      const level = await this.repository.findStockLevel(row.variantId, row.stockLocationId, scope);
      if (level === null) {
        // An active hold whose level is gone is corruption — the reserve path that
        // created the hold also created/raised the level.
        throw new Error(
          `Release: stock level for variant ${row.variantId} @ ${row.stockLocationId} is missing`,
        );
      }

      const expectedVersion = level.version;
      level.releaseReserved(row.quantity);
      // `release()` re-asserts the active state inside the tx — a hold a concurrent
      // writer already released throws `RESERVATION_INVALID_STATE` here.
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

  private async emitReleased(
    row: IReleasedRow,
    reason: ReservationReleaseReason,
    correlationId: string,
  ): Promise<void> {
    const { reservation, movement } = row;

    try {
      await this.publisher.publishStockReleased(
        new StockReleasedEvent({
          variantId: reservation.variantId,
          stockLocationId: reservation.stockLocationId,
          quantity: reservation.quantity,
          cartId: reservation.cartId,
          reservationId: reservation.id,
          reason,
        }),
        correlationId,
      );
    } catch (error) {
      this.logger.warn(
        { err: error as Error, correlationId, variantId: reservation.variantId },
        'Failed to publish inventory.stock.released (release already committed)',
      );
    }

    await emitMovementRecorded(this.publisher, this.logger, movement, correlationId);
  }
}
