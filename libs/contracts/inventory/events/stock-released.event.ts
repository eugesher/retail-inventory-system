import { ICorrelationPayload } from '../../microservices';
import { ReservationReleaseReason } from '../reservation';

export interface IInventoryStockReleasedEvent extends ICorrelationPayload {
  reservationId: string | null;
  variantId: number;
  stockLocationId: string;
  quantity: number;
  cartId: string | null;
  reason: ReservationReleaseReason;
  eventVersion: 'v1';
  occurredAt: string;
}
