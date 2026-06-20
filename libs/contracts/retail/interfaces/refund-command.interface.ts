import { ICorrelationPayload } from '../../microservices';

// Wire-format command payloads for the refund RPCs (API Gateway → Retail, served by the
// orders controller). Each extends `ICorrelationPayload` so the correlation id threads
// through to the retail handler's inline logging (ADR-001 / ADR-011). They are the single
// source of truth for both ends: the gateway adapter sends them and the retail refund use
// cases consume them as their `execute(payload)` input, so a drift fails TypeScript on
// both sides (the contract test).
//
// **Authorization is split across the boundary (ADR-024 / ADR-028 §7).** Issue Refund is
// **staff-only** (`order:refund`), gated with `@RequiresPermission` at the gateway, so the
// payload carries only the resolved `actorId` (the staff caller, for the audit row) — no
// owner-check flag. List Refunds is **owner-or-staff** `order:read`: the customer is never
// permission-gated for its own order's refunds (the route is bearer-protected and the use
// case owner-checks), while the staff override is computed at the gateway from
// `@CurrentUser().permissions` and forwarded here as `isStaff`.

// `retail.refund.issue` — issues a refund against a captured payment (staff `order:refund`).
// `amountMinor` is the amount to refund in integer minor units (cents); the use case
// validates it against the refundable ceiling (`payment.amountMinor −
// payment.refundedAmountMinor`). `reason` is the required human-supplied refund reason
// (recorded on the `refund` row + the audit log). `idempotencyKey` is **accepted + logged
// but not deduped** (ADR-032) — the gateway-reference natural idempotency + the
// `refunded_amount_minor` ceiling are what prevent an over-refund on replay. `actorId` is
// the resolved staff caller.
export interface IRetailRefundIssuePayload extends ICorrelationPayload {
  orderId: number;
  paymentId: number;
  amountMinor: number;
  reason: string;
  actorId: string;
  idempotencyKey?: string;
}

// `retail.refund.list` — lists an order's refunds newest-first (owner-or-staff
// `order:read`). `actorId` is the resolved caller; `isStaff` is the staff override (a
// non-staff caller may read only its own order's refunds, else `REFUND_ACCESS_FORBIDDEN`).
export interface IRetailRefundListPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  isStaff: boolean;
}
