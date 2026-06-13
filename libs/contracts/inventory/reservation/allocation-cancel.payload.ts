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
}
