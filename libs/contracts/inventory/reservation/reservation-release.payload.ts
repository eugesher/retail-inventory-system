import { ICorrelationPayload } from '../../microservices';

// One union, shared by the release payload, the `inventory.stock.released` wire event and the
// domain event — so a release's reason cannot mean one thing on the wire and another in the log.
export type ReservationReleaseReason = 'cart-removed' | 'expired' | 'order-cancelled' | 'manual';

// **Exactly one selector family, never both and never neither** — the use case rejects a payload
// that mixes them with `RESERVATION_SELECTOR_INVALID` (400). The two families answer to different
// failure philosophies, and picking the wrong one silently changes what "nothing matched" means:
//
//   * **`reservationId`** targets one row and is **loud**: an unknown id is a `404`, and a
//     non-active row a `409`. The precise ops/cleanup path is told "already released" rather than
//     succeeding at nothing.
//   * **`cartId`** (optionally narrowed by `variantId` / `stockLocationId`) targets **all** matching
//     *active* rows and is **quiet**: an empty match is an idempotent no-op, because removing a
//     line twice must not error.
//
// `reason` defaults to `cart-removed`; an absent `actorId` means the system acted.
export interface IReservationReleasePayload extends ICorrelationPayload {
  reservationId?: string;
  cartId?: string;
  variantId?: number;
  stockLocationId?: string;
  reason?: ReservationReleaseReason;
  actorId?: string;
}
