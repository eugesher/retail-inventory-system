import { ReservationView } from '@retail-inventory-system/contracts';

import { Reservation } from '../../domain';

export const toReservationView = (reservation: Reservation): ReservationView => {
  if (reservation.id === null) {
    throw new Error('toReservationView: reservation id is unexpectedly null');
  }

  return {
    reservationId: reservation.id,
    variantId: reservation.variantId,
    stockLocationId: reservation.stockLocationId,
    quantity: reservation.quantity,
    cartId: reservation.cartId,
    expiresAt: reservation.expiresAt.toISOString(),
    status: reservation.status as ReservationView['status'],
  };
};
