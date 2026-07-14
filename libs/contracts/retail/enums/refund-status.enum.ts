// One `refund` row = one gateway interaction against a captured `payment`.
//
// **`PENDING` means "we have written the row but not yet asked the gateway".** The row is created
// *before* the call, deliberately, so a crash mid-flight leaves evidence rather than silence. It
// then walks to exactly one terminal state once the gateway answers:
//
//   PENDING → ISSUED  the refund succeeded; stamps `gatewayReference` and `issuedAt`
//   PENDING → FAILED  the gateway declined
//
// Both are terminal, and a decline is **recorded**, never deleted — `refund` is append-only.
//
// **`FAILED` is unreachable in practice.** The bound gateway is a fake that always succeeds, so
// nothing can drive a refund into it; the transition is modelled for a real processor. Its
// presence is not evidence that declines are handled end to end.
export enum RefundStatusEnum {
  PENDING = 'pending',
  ISSUED = 'issued',
  FAILED = 'failed',
}
