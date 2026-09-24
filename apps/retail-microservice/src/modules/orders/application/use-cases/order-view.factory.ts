import { OrderLineView, OrderView, PaymentView } from '@retail-inventory-system/contracts';

import { Order, OrderLine, Payment } from '../../domain';

export const toOrderLineView = (line: OrderLine): OrderLineView => ({
  id: line.id!,
  variantId: line.variantId,
  sku: line.sku,
  nameSnapshot: line.nameSnapshot,
  quantity: line.quantity,
  cancelledQuantity: line.cancelledQuantity,
  unitPriceMinor: line.unitPriceMinor,
  taxAmountMinor: line.taxAmountMinor,
  discountAmountMinor: line.discountAmountMinor,
  lineTotalMinor: line.lineTotalMinor,
  status: line.status,
});

export const toPaymentView = (payment: Payment): PaymentView => ({
  id: payment.id!,
  orderId: payment.orderId,
  amountMinor: payment.amountMinor,
  currency: payment.currency,
  method: payment.method,
  status: payment.status,
  gatewayReference: payment.gatewayReference,
  authorizedAt: payment.authorizedAt ? payment.authorizedAt.toISOString() : null,
  capturedAt: payment.capturedAt ? payment.capturedAt.toISOString() : null,
});

export const toOrderView = (order: Order, payment?: Payment | null): OrderView => ({
  id: order.id!,
  orderNumber: order.orderNumber,
  customerId: order.customerId,
  currency: order.currency,
  status: order.status,
  paymentStatus: order.paymentStatus,
  fulfillmentStatus: order.fulfillmentStatus,
  subtotalMinor: order.subtotalMinor,
  taxTotalMinor: order.taxTotalMinor,
  discountTotalMinor: order.discountTotalMinor,
  shippingTotalMinor: order.shippingTotalMinor,
  grandTotalMinor: order.grandTotalMinor,
  billingAddressId: order.billingAddressId,
  shippingAddressId: order.shippingAddressId,
  placedAt: order.placedAt ? order.placedAt.toISOString() : null,
  version: order.version,
  lines: order.lines.map((line) => toOrderLineView(line)),
  payment: payment ? toPaymentView(payment) : undefined,
});
