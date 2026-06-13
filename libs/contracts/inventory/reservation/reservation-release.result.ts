import { ReservationView } from './reservation.view';

// Result of `inventory.reservation.release`: the rows that were flipped to
// `released` this call. Empty when a selector-B (`cartId`) match found no active
// rows — the idempotent no-op. A selector-A (`reservationId`) release always
// returns exactly one element (it 404s instead of returning empty).
export interface IReservationReleaseResult {
  released: ReservationView[];
}
