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

// The shared post-commit announce for a hold whose quantity has gone back to `available`. `reason`
// is the only thing that varies between the paths that use it, and it is already a parameter — so
// the emit policy itself stays in one place.
//
// **Not every `StockReleasedEvent` comes through here.** `CancelAllocationUseCase` builds its own,
// because an order cancel releases *allocations*, not holds: it has no reservation row and no cart
// to name, so it cannot supply an `IReleasedReservationRow`. Do not assume this helper is the only
// producer of the event.
//
// **Emitted PER RESERVATION ROW, never coalesced** per `(variantId, stockLocationId)`. Coalescing
// would mean summing quantities and nulling `cartId` / `reservationId` — which is the entire
// correlation value the event exists to carry (ADR-038).
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
