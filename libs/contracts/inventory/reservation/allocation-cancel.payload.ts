import { ICorrelationPayload } from '../../microservices';
import { IAllocationLine } from './reservation-allocate.payload';

// RPC payload for `inventory.allocation.cancel` (order-cancel flow / place-failure
// compensation → Inventory). Cancel-Allocation reverses an order's allocation
// (ADR-030 §4): per line it returns the allocated units to `available`
// (`StockLevel.releaseAllocated`) and appends one negative `release` movement
// referencing the order. **No reservation rows are touched** — they are
// `committed` (or never existed); cancelling an order does not resurrect a cart
// hold.
//
// `lines` must be non-empty; each `quantity` a positive integer; an omitted
// `stockLocationId` targets `INVENTORY_DEFAULT_STOCK_LOCATION`. `reason` is the
// movement's `reason_code` (defaults to `order-cancelled`); `actorId` the ops
// caller (null/absent = system). The cancel is all-lines-atomic, like allocate.
// Extends `ICorrelationPayload`; this interface doubles as the
// `CancelAllocationUseCase` input shape.
export interface IAllocationCancelPayload extends ICorrelationPayload {
  orderId: number;
  lines: IAllocationLine[];
  reason?: string;
  actorId?: string;
  // **The identity of THIS cancellation, minted by the caller** (ADR-057). Required.
  //
  // Cancel-Allocation is the one post-commit cross-service call with no natural key. Commit
  // Sale has a `fulfillmentId` and Restock a `returnRequestId` — each names a thing that is
  // cancelled/restocked exactly once. A cancellation names nothing: Cancel Line cancels a
  // *quantity*, so the same `(order, line, variant, location)` can legitimately be cancelled
  // again tomorrow. Without an identity supplied from outside, a redelivered cancel is
  // indistinguishable from a second, genuine one.
  //
  // The caller mints it ONCE per logical cancellation, before its retry loop, so every
  // retry and every broker redelivery of that operation carries the same value while a
  // genuinely new cancellation carries a different one. Inventory stores it on each
  // `release` movement, where `UC_STOCK_MOVEMENT_DEDUPE` makes the second write impossible
  // rather than merely unlikely.
  operationKey: string;
}
