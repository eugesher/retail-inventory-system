// **A fourth status axis, and it is not `order.fulfillment_status`.** This one lives on the
// shipment row — an order with split shipments has several `Fulfillment`s, each with its own
// status — while the order header's `fulfillment_status` is the **roll-up** across all of them
// (ADR-028 §2 / ADR-031). Reading one where you meant the other is the mistake this file exists
// to prevent.
//
// The machine — enforced by the `Fulfillment` aggregate, which lives in another service:
//
//   PENDING    the shipment is planned; nothing has left the warehouse
//   SHIPPED    the ship operation stamps tracking AND captures payment
//   DELIVERED  the deliver operation
//   CANCELLED  terminal, and reachable ONLY from `PENDING`
//
// **A `SHIPPED` or `DELIVERED` fulfillment can never be cancelled**, and that is precisely what
// protects Cancel Order: an order with goods already gone cannot be unwound. Cancellation is a
// status transition, never a row delete — `fulfillment` is append-only.
export enum FulfillmentStatusEnum {
  PENDING = 'pending',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}
