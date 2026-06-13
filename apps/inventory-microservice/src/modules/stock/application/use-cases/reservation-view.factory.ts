import { ReservationView } from '@retail-inventory-system/contracts';

import { Reservation } from '../../domain';

// Pure mapping from the `Reservation` domain model onto the wire `ReservationView`
// — framework-free and shared by the Reserve / Release use cases (the
// `stock-view.factory.ts` precedent, ADR-025). The domain `status` enum value is a
// string already, but its nominal enum type is not assignable to the view's raw
// string union without a coercion, so the cast bridges the deliberate
// domain-enum-stays-in-domain split (ADR-025 §7). `expiresAt` becomes an ISO-8601
// string on the wire.
export const toReservationView = (reservation: Reservation): ReservationView => {
  if (reservation.id === null) {
    // Only ever called on a created/persisted hold, whose id is concrete (the
    // app-generated UUID from `Reservation.create`); a null here is an internal
    // invariant breach, not a client error.
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
