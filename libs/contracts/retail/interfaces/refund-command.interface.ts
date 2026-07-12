import { ICorrelationPayload } from '../../microservices';

// Wire-format command payloads for the refund RPCs (ADR-032). One type, both ends: a drift fails
// TypeScript on the gateway *and* in retail. That is the contract test.
//
// **Issue Refund is staff-only**, gated at the gateway with `@RequiresPermission`, which is why
// it carries no owner-check flag. **List Refunds is owner-or-staff**, so it carries `isStaff` —
// the gateway resolves the permission and forwards the *result*, never the permissions.

// **`actorId` is nullable, and that is the whole design.** For the manual endpoint it is the staff
// caller. It is **`null` on the auto-refund-from-cancel path**: retail's own consumer reacts to
// `retail.order.cancelled` with `paymentFlaggedForRefund=true` and calls `IssueRefundUseCase`
// directly, with no human behind it. The audit contract already models a null actor as a system
// movement, so both paths share one use case without inventing a sentinel id.
//
// `amountMinor` is checked against the refundable ceiling — `payment.amountMinor` minus what has
// already been refunded — so a partial refund is legal and a second one that would overshoot is
// not. `reason` is required, and lands on both the `refund` row and the audit log.
//
// `idempotencyKey` is optional in the type and **required in fact** (ADR-036). The use case
// fingerprints `{orderId, paymentId, amountMinor, reason}` and replays the stored `RefundView` on
// a same-key/same-body hit — **before the gateway call and before the audit emit**, so a replay
// moves no money and writes no second audit row. A different body is a `422`, an absent key a
// `400`. The auto-refund consumer has no client header to forward, so it synthesizes a
// deterministic `order-cancelled:<orderId>:<paymentId>` key instead.
export interface IRetailRefundIssuePayload extends ICorrelationPayload {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  reason: string;
  actorId: string | null;
  idempotencyKey?: string;
}

// A non-staff caller reading someone else's order's refunds gets `REFUND_ACCESS_FORBIDDEN`, not an
// empty list.
export interface IRetailRefundListPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  isStaff: boolean;
}
