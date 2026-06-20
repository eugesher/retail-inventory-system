import { ReturnLineView, ReturnRequestView } from '@retail-inventory-system/contracts';

import { ReturnLine, ReturnRequest } from '../../domain';

// Pure mapping from the returns domain onto its wire view, shared by every return use
// case so the projection lives in exactly one place (the `order-view.factory` /
// `fulfillment-view.factory` pattern). Framework-free — no Nest decorators.
//
// A persisted return request (saved or reconstituted) carries a concrete id, and a line
// re-read from the repository carries its generated BIGINT id, so the `!` assertions are
// safe here (the same non-null assertion the order/fulfillment factories make). The three
// `Date` columns are serialized to ISO-8601 strings (null until the matching transition
// stamps them).

export const toReturnLineView = (line: ReturnLine): ReturnLineView => ({
  id: line.id!,
  orderLineId: line.orderLineId,
  quantity: line.quantity,
  condition: line.condition,
  disposition: line.disposition,
  lineRefundAmountMinor: line.lineRefundAmountMinor,
});

export const toReturnRequestView = (request: ReturnRequest): ReturnRequestView => ({
  id: request.id!,
  rmaNumber: request.rmaNumber,
  orderId: request.orderId,
  customerId: request.customerId,
  status: request.status,
  reasonCategory: request.reasonCategory,
  notes: request.notes,
  requestedAt: request.requestedAt.toISOString(),
  authorizedAt: request.authorizedAt ? request.authorizedAt.toISOString() : null,
  closedAt: request.closedAt ? request.closedAt.toISOString() : null,
  lines: request.lines.map((line) => toReturnLineView(line)),
  version: request.version,
  createdAt: request.createdAt ? request.createdAt.toISOString() : null,
  updatedAt: request.updatedAt ? request.updatedAt.toISOString() : null,
});
