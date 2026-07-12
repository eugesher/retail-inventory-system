// The fulfillment-progress axis — **one of three orthogonal status fields** on an
// order (ADR-028 §2). Fulfillment progresses independently of the order lifecycle
// and of payment. A wire contract surfacing on `OrderView` and mapped to the
// `order.fulfillment_status` ENUM column.
//
// `UNFULFILLED` is the place-time default. **All four values are reached today**:
// Ship recomputes this axis from the order's lines and lands `SHIPPED` when every
// line is fully shipped, `PARTIALLY_SHIPPED` otherwise; Deliver sets `DELIVERED`.
//
// This is the axis that carries shipment progress — **not** `OrderStatusEnum`, whose
// own `SHIPPED` member has no producer precisely because the two axes are orthogonal
// (ADR-028 §2). Read shipment state from here.
export enum OrderFulfillmentStatusEnum {
  UNFULFILLED = 'unfulfilled',
  PARTIALLY_SHIPPED = 'partially-shipped',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
}
