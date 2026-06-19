// A `Refund`'s lifecycle axis — the status of a single `refund` row, the record of
// one gateway refund interaction against a captured `payment`. A `Refund` only ever
// exists because Issue Refund opened it, so its earliest state is `PENDING` (the
// row is written before the gateway is called), then it walks to exactly one
// terminal state once the gateway answers.
//
// It is a wire contract (not an internal domain enum) because it surfaces on
// `RefundView` and is mapped to the `refund.status` ENUM column, so it lives in
// `libs/contracts` where both the retail microservice and the gateway read it (the
// `PaymentStatusEnum` precedent, ADR-005).
//
// The transitions:
//   PENDING → ISSUED  (the gateway refund succeeded — stamps `gatewayReference` +
//                      `issuedAt`)
//   PENDING → FAILED  (the gateway declined — terminal; unreachable with the
//                      always-succeed fake gateway, but modeled, the
//                      `ORDER_PAYMENT_NOT_APPROVED` precedent)
// `ISSUED` and `FAILED` are terminal. A refund row is append-only (`deleted_at`
// inert) — a decline is recorded as `FAILED`, never a delete.
export enum RefundStatusEnum {
  PENDING = 'pending',
  ISSUED = 'issued',
  FAILED = 'failed',
}
