import { ICorrelationPayload } from '../../microservices';

// One line of an allocate / cancel-allocation request: the variant, the location
// (optional — omit to target `INVENTORY_DEFAULT_STOCK_LOCATION`), and the
// positive quantity to allocate or cancel. Shared by the allocate and cancel
// payloads so the two stay shape-aligned in one place.
export interface IAllocationLine {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
}

// RPC payload for `inventory.reservation.allocate` (Retail place transaction →
// Inventory). Allocate converts a cart's active holds into firm order allocations
// (ADR-030 §4): per line it commits the hold (`active → committed`, refreshing the
// TTL first when wall-clock-stale-but-still-held) and moves the counter from
// reserved to allocated; when no active hold exists it falls back to a direct
// allocation against `available`.
//
// The lines ride the payload — rather than the inventory service reading retail's
// cart tables — so the fallback path can allocate without a cross-service read
// (ADR-030). `lines` must be non-empty; each `quantity` a positive integer; an
// omitted `stockLocationId` targets `INVENTORY_DEFAULT_STOCK_LOCATION`. The whole
// allocate is all-lines-atomic (a partial allocation never commits). Extends
// `ICorrelationPayload` (the caller always threads the id on this command path);
// this interface doubles as the `AllocateStockUseCase` input shape.
export interface IReservationAllocatePayload extends ICorrelationPayload {
  cartId: string;
  orderId: number;
  lines: IAllocationLine[];
}
