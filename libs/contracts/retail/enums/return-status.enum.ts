// A `ReturnRequest`'s lifecycle axis — the six-state RMA (Return Merchandise
// Authorization) machine that drives a delivered/shipped order's return from the
// buyer's request through to settlement. Unlike the four-state `FulfillmentStatusEnum`
// (which tracks goods leaving the warehouse), this tracks goods coming *back*.
//
// It is a wire contract (not an internal domain enum like the catalog
// `ProductStatusEnum`) because it surfaces on `ReturnRequestView` and is mapped to
// the `return_request.status` ENUM column, so it lives in `libs/contracts` where both
// the retail microservice and the gateway read it (the `OrderStatusEnum` /
// `FulfillmentStatusEnum` precedent, ADR-005).
//
// The transitions:
//   REQUESTED → AUTHORIZED  (staff `order:return-authorize` approves the RMA)
//   REQUESTED → REJECTED    (staff rejects — terminal, stamps `closedAt`)
//   AUTHORIZED → RECEIVED   (warehouse `inventory:receive-return` logs the goods in)
//   RECEIVED  → INSPECTED   (warehouse records per-line condition + disposition)
//   INSPECTED → CLOSED      (staff settles — terminal, stamps `closedAt`)
// `REJECTED` and `CLOSED` are terminal. Rejection/closure are status transitions,
// never row deletes — `return_request` is append-only (`deleted_at` inert).
export enum ReturnStatusEnum {
  REQUESTED = 'requested',
  AUTHORIZED = 'authorized',
  REJECTED = 'rejected',
  RECEIVED = 'received',
  INSPECTED = 'inspected',
  CLOSED = 'closed',
}
