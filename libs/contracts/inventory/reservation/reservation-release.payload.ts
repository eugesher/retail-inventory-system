import { ICorrelationPayload } from '../../microservices';

// The reasons a hold is released. `cart-removed` (a line removed from a cart) is
// the default; `expired` is the future sweeper's reason; `order-cancelled` the
// later order-cancel flow's; `manual` an ops endpoint's. Shared by the release
// payload, the `inventory.stock.released` wire event, and the domain
// `StockReleasedEvent`, so the union lives in exactly one place.
export type ReservationReleaseReason = 'cart-removed' | 'expired' | 'order-cancelled' | 'manual';

// RPC payload for `inventory.reservation.release` (Gateway / Retail → Inventory).
// Release returns held units to `available` and writes a `release` movement
// (ADR-030 §4). It carries **exactly one selector family** — the use case rejects
// both-present / neither-present with `RESERVATION_SELECTOR_INVALID` (400):
//
//   * Selector A — `reservationId`: targets exactly one row; an unknown id is a
//     `RESERVATION_NOT_FOUND` (404) and a non-active row a `RESERVATION_INVALID_STATE`
//     (409) — the precise ops/cleanup path hears "already released", never a silent
//     no-op.
//   * Selector B — `cartId` (+ optional `variantId` + optional `stockLocationId`):
//     targets ALL matching *active* rows; an empty match is an idempotent no-op
//     (remove-after-remove must not error).
//
// `reason` defaults to `cart-removed`. `actorId` is the ops caller (null/absent =
// system). Extends `ICorrelationPayload` (the gateway always threads the id on this
// command path); this interface doubles as the `ReleaseReservationUseCase` input.
export interface IReservationReleasePayload extends ICorrelationPayload {
  reservationId?: string;
  cartId?: string;
  variantId?: number;
  stockLocationId?: string;
  reason?: ReservationReleaseReason;
  actorId?: string;
}
