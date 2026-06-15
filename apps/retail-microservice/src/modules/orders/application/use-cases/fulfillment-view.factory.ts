import { FulfillmentLineView, FulfillmentView } from '@retail-inventory-system/contracts';

import { Fulfillment, FulfillmentLine } from '../../domain';

// Pure mapping from the fulfillment domain onto its wire view, shared by the Create
// and List use cases (and the later Ship / Deliver / Cancel views) so the projection
// lives in exactly one place (the `order-view.factory` / cart `cart-view.factory`
// pattern). Framework-free — no Nest decorators.
//
// A persisted fulfillment (saved or reconstituted) carries a concrete id, and a line
// re-read from the repository carries its generated BIGINT id, so the `!` assertions
// are safe here (the same non-null assertion the order factory makes). The two `Date`
// columns are serialized to ISO-8601 strings (null until the ship / deliver operations
// stamp them).

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
