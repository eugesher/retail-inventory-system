// The **payment-row** status — the lifecycle of a single `payment` row, distinct
// from the order's `OrderPaymentStatusEnum` (the payment *axis* on the order
// header). The two never share a value set: the order axis carries a `NONE` member
// for the pre-payment window (an order exists before any money moves), but a
// `payment` **row** only ever exists because an authorize succeeded, so its
// earliest state is `AUTHORIZED` — there is no `none` here. Encoding the
// distinction as two enums keeps the type system, not a comment, the guard.
//
// A wire contract: it surfaces on `PaymentView` and is mapped to the
// `payment.status` ENUM column. `AUTHORIZED` means funds are reserved (the
// authorize-on-place capability); `CAPTURED` means the money was taken (the
// explicit capture capability). `VOIDED` / `REFUNDED` / `FAILED` ship in the enum
// for the later cancel/refund/decline capabilities but have no producer in this
// chain — the only mutation today walks `AUTHORIZED → CAPTURED`.
export enum PaymentStatusEnum {
  AUTHORIZED = 'authorized',
  CAPTURED = 'captured',
  VOIDED = 'voided',
  REFUNDED = 'refunded',
  FAILED = 'failed',
}
