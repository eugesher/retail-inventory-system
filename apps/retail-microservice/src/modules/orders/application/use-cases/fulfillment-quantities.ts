import { FulfillmentStatusEnum } from '@retail-inventory-system/contracts';

import { Fulfillment } from '../../domain';

// Sums each order line's quantity across the fulfillments matching `include`, keyed by
// `orderLineId`. The single reducer behind every cross-fulfillment quantity roll-up:
// Create's / Cancel Line's already-fulfilled remainder (non-cancelled fulfillments) and
// Ship's shipped count (shipped/delivered fulfillments). The fold lives here once;
// keeping the predicate at the call site keeps each "what counts" rule visible.
export function sumLineQuantitiesByOrderLine(
  fulfillments: Fulfillment[],
  include: (fulfillment: Fulfillment) => boolean,
): Map<number, number> {
  const byLine = new Map<number, number>();
  for (const fulfillment of fulfillments) {
    if (!include(fulfillment)) {
      continue;
    }
    for (const line of fulfillment.lines) {
      byLine.set(line.orderLineId, (byLine.get(line.orderLineId) ?? 0) + line.quantity);
    }
  }
  return byLine;
}

// A non-`cancelled` fulfillment still holds its slice of the ordered quantity — the
// remainder Create and Cancel Line measure against (a cancelled shipment frees its slice
// back to the pool).
export const countsTowardFulfilled = (fulfillment: Fulfillment): boolean =>
  fulfillment.status !== FulfillmentStatusEnum.CANCELLED;

// A `shipped`/`delivered` fulfillment has physically left — the units Ship's order
// roll-up counts (a `pending`/`cancelled` shipment contributes nothing).
export const countsTowardShipped = (fulfillment: Fulfillment): boolean =>
  fulfillment.status === FulfillmentStatusEnum.SHIPPED ||
  fulfillment.status === FulfillmentStatusEnum.DELIVERED;
