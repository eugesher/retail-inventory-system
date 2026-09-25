import { PinoLogger } from 'nestjs-pino';

import { ReservationReleaseReason } from '@retail-inventory-system/contracts';

import { Reservation, StockMovement, StockReleasedEvent } from '../../domain';
import { IStockEventsPublisherPort } from '../ports';
import { emitMovementRecorded } from './movement-recorded.emitter';

export interface IReleasedReservationRow {
  reservation: Reservation;
  movement: StockMovement;
}

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
