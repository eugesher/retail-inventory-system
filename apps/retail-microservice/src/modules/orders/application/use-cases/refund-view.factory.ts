import { RefundView } from '@retail-inventory-system/contracts';

import { Refund } from '../../domain';

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
