// The **payment-row** status — the lifecycle of a single `payment` row, distinct
// from the order's `OrderPaymentStatusEnum` (the payment *axis* on the order
// header). The two never share a value set: the order axis carries a `NONE` member
// for the pre-payment window (an order exists before any money moves), but a
// `payment` **row** only ever exists because an authorize succeeded, so its
// earliest state is `AUTHORIZED` — there is no `none` here. Encoding the
// distinction as two enums keeps the type system, not a comment, the guard.
//
// `AUTHORIZED` means funds are reserved; `CAPTURED` means they were taken. `VOIDED` is set when a
// cancel voids an un-captured authorization, and `REFUNDED` when a refund covers the captured
// amount in full — both are live.
//
// **`FAILED` is the one member nothing produces.** The bound payment gateway is a fake that always
// succeeds, so no code path can reach it. Do not read its presence as evidence that a decline is
// handled somewhere.
export enum PaymentStatusEnum {
  AUTHORIZED = 'authorized',
  CAPTURED = 'captured',
  VOIDED = 'voided',
  REFUNDED = 'refunded',
  FAILED = 'failed',
}
