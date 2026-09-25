import { FulfillmentStatusEnum } from '@retail-inventory-system/contracts';

import { Fulfillment } from '../../domain';

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

export const countsTowardFulfilled = (fulfillment: Fulfillment): boolean =>
  fulfillment.status !== FulfillmentStatusEnum.CANCELLED;

export const countsTowardShipped = (fulfillment: Fulfillment): boolean =>
  fulfillment.status === FulfillmentStatusEnum.SHIPPED ||
  fulfillment.status === FulfillmentStatusEnum.DELIVERED;
