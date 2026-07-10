import { PinoLogger } from 'nestjs-pino';

import { ReservationReleaseReason } from '@retail-inventory-system/contracts';

import { Reservation, StockMovement, StockReleasedEvent } from '../../domain';
import { IStockEventsPublisherPort } from '../ports';
import { emitMovementRecorded } from './movement-recorded.emitter';

// One settled hold + the ledger row that records it, carried out of the transaction so the
// post-commit emits can fire per row. Shared by both paths that return held units to
// `available` — an explicit Release and a TTL expiry — because both produce exactly this
// pair (ADR-030 §4 / ADR-038).
export interface IReleasedReservationRow {
  reservation: Reservation;
  movement: StockMovement;
}

// The shared post-commit announce for a hold whose quantity has been returned to
// `available`, hoisted out of `ReleaseReservationUseCase` and
// `SweepExpiredReservationsUseCase` so they share one best-effort emit policy — the
// `emitMovementRecorded` / `maybeEmitLowStock` precedent. Only `reason` differs between the
// two callers (`cart-removed` / `order-cancelled` / `manual` versus `expired`), and it is
// already the parameter that carries that difference onto both the event and the ledger row.
//
// Emitted PER RESERVATION ROW, never coalesced per `(variantId, stockLocationId)`: coalescing
// would have to sum quantities and null `cartId` / `reservationId`, which is the whole
// correlation value the event carries (ADR-038).
//
// Both emits are best-effort and post-commit (ADR-020): the counter and the ledger row are
// already durable, so a broker hiccup is warn-logged, never raised — failing the caller would
// mislead it into thinking the committed write did not happen.
export const emitReservationReleased = async (
  publisher: IStockEventsPublisherPort,
  logger: PinoLogger,
  row: IReleasedReservationRow,
  reason: ReservationReleaseReason,
  correlationId?: string,
): Promise<void> => {
  const { reservation, movement } = row;

  try {
    await publisher.publishStockReleased(
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
    logger.warn(
      { err: error as Error, correlationId, variantId: reservation.variantId, reason },
      'Failed to publish inventory.stock.released (release already committed)',
    );
  }

  await emitMovementRecorded(publisher, logger, movement, correlationId);
};
