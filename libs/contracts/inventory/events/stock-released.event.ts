import { ICorrelationPayload } from '../../microservices';
import { ReservationReleaseReason } from '../reservation';

// `inventory.stock.released` — a **reserved surface** (README §2). Not dead code.
//
// `reservationId` and `cartId` are both **nullable**, because a release does not always come from
// a single hold: cancelling an order releases by order, and the sweeper releases by expiry. A
// consumer keying on `cartId` will silently drop those. `reason` is the discriminator that tells
// them apart.
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
