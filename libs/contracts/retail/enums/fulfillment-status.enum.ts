// A `Fulfillment`'s own lifecycle axis — a **fourth** status axis alongside the
// three orthogonal order axes (`order.status` / `order.payment_status` /
// `order.fulfillment_status`, ADR-028 §2). A `Fulfillment` is a per-shipment,
// per-location record (an order with split shipments has several), so its status
// lives on the shipment row, while the order's own `fulfillment_status` is the
// roll-up across all of its fulfillments (ADR-031).
//
// It is a wire contract (not an internal domain enum like the catalog
// `ProductStatusEnum`) because it surfaces on `FulfillmentView` and is mapped to
// the `fulfillment.status` ENUM column, so it lives in `libs/contracts` where both
// the retail microservice and the gateway read it (the `OrderStatusEnum` precedent,
// ADR-005).
//
// `PENDING` is the just-created state (the shipment is planned but not yet shipped);
// `SHIPPED` is reached by the ship operation (which stamps `shippedAt`/tracking and
// captures payment); `DELIVERED` by the deliver operation; `CANCELLED` is the
// terminal cancellation of a still-`PENDING` shipment (a `SHIPPED`/`DELIVERED`
// fulfillment is never cancellable — that is what protects Cancel Order's
// precondition). Cancellation is a status transition, never a row delete —
// `fulfillment` is append-only.
export enum FulfillmentStatusEnum {
  PENDING = 'pending',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
  CANCELLED = 'cancelled',
}
