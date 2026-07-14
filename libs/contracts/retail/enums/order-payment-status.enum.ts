// The payment-progress axis — **one of three orthogonal status fields** on an
// order (ADR-028 §2). Payment progresses independently of the order lifecycle and
// of fulfillment: an order can be `CONFIRMED` with payment `AUTHORIZED` while
// fulfillment is still `unfulfilled`. A wire contract surfacing on `OrderView` and
// mapped to the `order.payment_status` ENUM column.
//
// `NONE` is the place-time default; `AUTHORIZED` means funds are reserved; `CAPTURED` means
// the money has been taken. The axis walks `NONE → AUTHORIZED → CAPTURED` and stops.
//
// **`REFUNDED` and `FAILED` have no producer, and that is not a gap waiting on a capability
// — refunds shipped and still do not set them.** A refund is recorded on the `Payment`
// aggregate, never on this axis, so an order that has been refunded in full goes on reading
// `CAPTURED`. **Do not read `OrderView.paymentStatus` to find out whether an order was
// refunded**; read the order's refunds.
export enum OrderPaymentStatusEnum {
  NONE = 'none',
  AUTHORIZED = 'authorized',
  CAPTURED = 'captured',
  REFUNDED = 'refunded',
  FAILED = 'failed',
}
