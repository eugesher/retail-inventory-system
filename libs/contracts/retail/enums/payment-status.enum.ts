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
// amount in full — all live.
//
// **`CAPTURING` is the durable claim, and it is the only non-terminal state here** (ADR-052). It
// means *"a caller has been authorised to charge this authorization, and may already have done
// so."* Both capture paths — the explicit `CapturePaymentUseCase` and the ship-triggered capture in
// `ShipFulfillmentUseCase` — must write it **under a row lock, in a committed transaction, BEFORE
// calling the gateway**. That is what makes a double charge impossible: the loser of the race blocks
// on the lock, then reads `CAPTURING` instead of `AUTHORIZED`, and refuses *without ever reaching the
// processor*. Previously both paths checked `AUTHORIZED` on an unlocked read and charged; the loser
// then threw `PAYMENT_INVALID_STATUS_TRANSITION` and rolled back a transaction that **cannot un-call
// a payment gateway** (ISSUE-05 / ISSUE-07).
//
// It is also what a **cancel** must refuse. `Payment.void()` on a `CAPTURING` row would void an
// authorization whose money may already be gone; Cancel Order rejects instead.
//
// **A `CAPTURING` row that outlives its request is EVIDENCE, and that is the point.** A crash between
// the claim and the completion leaves one, and nobody may assume the money did not move — the gateway
// offers no "did it?" query. `StaleCaptureClaimScheduler` surfaces them for an operator; **nothing
// auto-releases them**, because releasing a claim whose charge did land is how you charge twice.
//
// **`FAILED` is the one member nothing produces.** The bound payment gateway is a fake that always
// succeeds, so no code path can reach it. Do not read its presence as evidence that a decline is
// handled somewhere — a declined capture releases the claim back to `AUTHORIZED`.
export enum PaymentStatusEnum {
  AUTHORIZED = 'authorized',
  CAPTURING = 'capturing',
  CAPTURED = 'captured',
  VOIDED = 'voided',
  REFUNDED = 'refunded',
  FAILED = 'failed',
}
