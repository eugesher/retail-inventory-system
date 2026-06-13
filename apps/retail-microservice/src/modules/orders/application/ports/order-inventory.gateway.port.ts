import {
  IAllocationCancelPayload,
  IAllocationResult,
  IReservationAllocatePayload,
} from '@retail-inventory-system/contracts';

export const ORDER_INVENTORY_GATEWAY = Symbol('ORDER_INVENTORY_GATEWAY');

// The seam Place Order uses to convert a cart's stock holds into firm order
// allocations (and to unwind them on a rare post-allocate failure) against the
// inventory reservation surface (`inventory.reservation.allocate` /
// `inventory.allocation.cancel`, ADR-030 §4). It keeps `PlaceOrderUseCase` free of
// any transport import (ADR-009 / ADR-020) — `OrderInventoryRabbitmqAdapter` is
// the only `ClientProxy` holder behind it.
//
// This is the orders half of what the plan called `INVENTORY_RESERVATION_GATEWAY`;
// it lands as a module-prefixed port (`ORDER_INVENTORY_GATEWAY`) because the cart
// and orders modules are isolated (ADR-028) and each follows the established
// `<MODULE>_<DOWNSTREAM>_GATEWAY` convention. The cart half is
// `CART_INVENTORY_GATEWAY`.
//
// - `allocateStock` is called INSIDE the place transaction, after the
//   cart-conversion compare-and-swap (ADR-030): per line it commits the active
//   hold and moves the counter reserved → allocated, falling back to a direct
//   allocation when no hold exists. It is all-lines-atomic; an out-of-stock
//   fallback rejects with `INVENTORY_OUT_OF_STOCK` and the whole place rolls back.
// - `cancelAllocation` is the place-failure compensation: it reverses an order's
//   allocation (a negative `release` movement per line) and runs OUTSIDE the failed
//   transaction (its own RPC into inventory's own transaction).
export interface IOrderInventoryGatewayPort {
  allocateStock(payload: IReservationAllocatePayload): Promise<IAllocationResult>;
  cancelAllocation(payload: IAllocationCancelPayload): Promise<void>;
}
