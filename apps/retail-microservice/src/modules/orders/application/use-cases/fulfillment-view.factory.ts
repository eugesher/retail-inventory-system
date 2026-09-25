import { FulfillmentLineView, FulfillmentView } from '@retail-inventory-system/contracts';

import { Fulfillment, FulfillmentLine } from '../../domain';

export const toFulfillmentLineView = (line: FulfillmentLine): FulfillmentLineView => ({
  id: line.id!,
  orderLineId: line.orderLineId,
  quantity: line.quantity,
});

export const toFulfillmentView = (fulfillment: Fulfillment): FulfillmentView => ({
  id: fulfillment.id!,
  orderId: fulfillment.orderId,
  stockLocationId: fulfillment.stockLocationId,
  status: fulfillment.status,
  trackingNumber: fulfillment.trackingNumber,
  carrier: fulfillment.carrier,
  shippedAt: fulfillment.shippedAt ? fulfillment.shippedAt.toISOString() : null,
  deliveredAt: fulfillment.deliveredAt ? fulfillment.deliveredAt.toISOString() : null,
  lines: fulfillment.lines.map((line) => toFulfillmentLineView(line)),
  version: fulfillment.version,
  createdAt: fulfillment.createdAt ? fulfillment.createdAt.toISOString() : null,
  updatedAt: fulfillment.updatedAt ? fulfillment.updatedAt.toISOString() : null,
});
