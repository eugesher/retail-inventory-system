// The payment-progress axis — **one of three orthogonal status fields** on an
// order (ADR-028 §2). Payment progresses independently of the order lifecycle and
// of fulfillment: an order can be `CONFIRMED` with payment `AUTHORIZED` while
// fulfillment is still `unfulfilled`. A wire contract surfacing on `OrderView` and
// mapped to the `order.payment_status` ENUM column.
//
// `NONE` is the place-time default; `AUTHORIZED` means funds are reserved; `CAPTURED` means
// the money has been taken. The happy walk is `NONE → AUTHORIZED → CAPTURED` and it stops there.
//
// **`FAILED` is the `NONE` branch's terminal: the authorize was DECLINED.** Place commits the order,
// converts the cart and allocates the stock, and only *then* asks the gateway — so a decline lands on
// an order that already exists. This axis is what records it (ISSUE-06 / ADR-052), and the order's
// lifecycle axis goes `CANCELLED` alongside: **this one says *why* the order is dead, that one says
// *that* it is.** Splitting it across the two axes rather than inventing a `payment-failed` lifecycle
// member is the orthogonality of ADR-028 §2 doing its job.
//
// It went unproduced for eleven epics. **The member was modelled and the decline path was not** —
// which is exactly how the orphan survived: an order with a declined card read `pending` / `none`,
// indistinguishable from a healthy one.
//
// **`REFUNDED` still has no producer, and that is not a gap waiting on a capability — refunds shipped
// and still do not set it.** A refund is recorded on the `Payment` aggregate, never on this axis, so
// an order refunded in full goes on reading `CAPTURED`. **Do not read `OrderView.paymentStatus` to
// find out whether an order was refunded**; read the order's refunds.
export enum OrderPaymentStatusEnum {
  NONE = 'none',
  AUTHORIZED = 'authorized',
  CAPTURED = 'captured',
  REFUNDED = 'refunded',
  FAILED = 'failed',
}
