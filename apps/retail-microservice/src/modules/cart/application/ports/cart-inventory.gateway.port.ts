import {
  IReservationReleasePayload,
  IReservationReleaseResult,
  IReservationReservePayload,
  ReservationView,
} from '@retail-inventory-system/contracts';

export const CART_INVENTORY_GATEWAY = Symbol('CART_INVENTORY_GATEWAY');

// The seam the cart write path uses to hold (and release) stock against the
// reservation surface in the inventory microservice (`inventory.reservation.*`,
// ADR-030). It keeps the Add/Change/Remove use cases free of any transport import
// (ADR-009 / ADR-020) — `CartInventoryRabbitmqAdapter` is the only `ClientProxy`
// holder behind it.
//
// This is the cart half of what the plan called `INVENTORY_RESERVATION_GATEWAY`;
// it lands as a module-prefixed port (`CART_INVENTORY_GATEWAY`) because the cart
// and orders modules are isolated (ADR-028) and each follows the established
// `<MODULE>_<DOWNSTREAM>_GATEWAY` convention (`CART_CATALOG_GATEWAY` /
// `ORDER_CATALOG_GATEWAY`). The order half is `ORDER_INVENTORY_GATEWAY`.
//
// - `reserveStock` holds the **absolute** target quantity for the
//   `(cartId, variantId)` triple at the default location (no `stockLocationId` —
//   single-location routing; inventory defaults it). A re-reserve sets the hold to
//   that absolute quantity and refreshes the TTL (idempotent-by-absolute-quantity).
//   An out-of-stock target rejects with `INVENTORY_OUT_OF_STOCK` carrying
//   `details.available`; the rejection propagates to the gateway verbatim.
// - `releaseStock` returns held units to `available`. The cart calls it by
//   `cartId` + `variantId` (selector B), an idempotent no-op when no active hold
//   matches.
export interface ICartInventoryGatewayPort {
  reserveStock(payload: IReservationReservePayload): Promise<ReservationView>;
  releaseStock(payload: IReservationReleasePayload): Promise<IReservationReleaseResult>;
}
