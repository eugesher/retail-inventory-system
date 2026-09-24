import { ICorrelationPayload } from '../../microservices';

export type ReservationReleaseReason = 'cart-removed' | 'expired' | 'order-cancelled' | 'manual';

export interface IReservationReleasePayload extends ICorrelationPayload {
  reservationId?: string;
  cartId?: string;
  variantId?: number;
  stockLocationId?: string;
  reason?: ReservationReleaseReason;
  actorId?: string;
}
