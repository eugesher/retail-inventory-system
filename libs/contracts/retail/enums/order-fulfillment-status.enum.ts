// The fulfillment-progress axis — **one of three orthogonal status fields** on an
// order (ADR-028 §2). Fulfillment progresses independently of the order lifecycle
// and of payment. A wire contract surfacing on `OrderView` and mapped to the
// `order.fulfillment_status` ENUM column.
//
// `UNFULFILLED` is the place-time default; `PARTIALLY_SHIPPED` / `SHIPPED` /
// `DELIVERED` are reached by the later fulfillment capability. This foundation only
// ever sets `UNFULFILLED` (at place-time); the shipment transitions arrive with the
// fulfillment operations that drive them.
export enum OrderFulfillmentStatusEnum {
  UNFULFILLED = 'unfulfilled',
  PARTIALLY_SHIPPED = 'partially-shipped',
  SHIPPED = 'shipped',
  DELIVERED = 'delivered',
}
