// The payment-progress axis — **one of three orthogonal status fields** on an
// order (ADR-028 §2). Payment progresses independently of the order lifecycle and
// of fulfillment: an order can be `CONFIRMED` with payment `AUTHORIZED` while
// fulfillment is still `unfulfilled`. A wire contract surfacing on `OrderView` and
// mapped to the `order.payment_status` ENUM column.
//
// `NONE` is the place-time default; `AUTHORIZED` means funds are reserved (the
// authorize-on-place capability); `CAPTURED` means the money has been taken (the
// explicit capture capability). `REFUNDED` / `FAILED` ship in the enum for the
// later refund/decline capabilities but have no producer in this chain — the
// foundation's payment-status mutators only walk `NONE → AUTHORIZED → CAPTURED`.
export enum OrderPaymentStatusEnum {
  NONE = 'none',
  AUTHORIZED = 'authorized',
  CAPTURED = 'captured',
  REFUNDED = 'refunded',
  FAILED = 'failed',
}
