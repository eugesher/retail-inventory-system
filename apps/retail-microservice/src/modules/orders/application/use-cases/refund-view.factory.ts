import { RefundView } from '@retail-inventory-system/contracts';

import { Refund } from '../../domain';

// Pure mapping from the refund domain onto its wire view, shared by Issue Refund and
// List Refunds so the projection lives in exactly one place (the `order-view.factory` /
// `fulfillment-view.factory` pattern). Framework-free — no Nest decorators.
//
// Every call site maps a **persisted** refund (re-read after save, or loaded from the
// repository), so the generated BIGINT id and the committed `createdAt` / `updatedAt`
// timestamps are concrete — the `!` assertions are safe (the order factory convention).
// `gatewayReference` / `issuedAt` stay null while a refund is `pending` and are stamped
// once the gateway answers.
export const toRefundView = (refund: Refund): RefundView => ({
  id: refund.id!,
  orderId: refund.orderId,
  paymentId: refund.paymentId,
  amountMinor: refund.amountMinor,
  currency: refund.currency,
  status: refund.status,
  reason: refund.reason,
  gatewayReference: refund.gatewayReference,
  issuedAt: refund.issuedAt ? refund.issuedAt.toISOString() : null,
  createdAt: refund.createdAt!.toISOString(),
  updatedAt: refund.updatedAt!.toISOString(),
});
