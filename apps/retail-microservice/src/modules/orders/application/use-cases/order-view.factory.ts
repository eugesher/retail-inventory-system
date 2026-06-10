import { OrderLineView, OrderView, PaymentView } from '@retail-inventory-system/contracts';

import { Order, OrderLine, Payment } from '../../domain';

// Pure mapping from the order domain onto its wire view, shared by the order use
// cases so the projection lives in exactly one place (the cart `cart-view.factory`
// / catalog `catalog-view.factory` pattern). Framework-free — no Nest decorators.
//
// A persisted order (placed or reconstituted) carries a concrete id, and a line
// re-read from the repository carries its generated BIGINT id, so the `!`
// assertions are safe here (the same non-null assertion the cart factory makes).

export const toOrderLineView = (line: OrderLine): OrderLineView => ({
  id: line.id!,
  variantId: line.variantId,
  sku: line.sku,
  nameSnapshot: line.nameSnapshot,
  quantity: line.quantity,
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

// `payment` is folded onto the view only when an order has one (placed-and-authorized
// orders do; a bare placed order before authorize would not). `undefined` omits the
// optional field rather than serializing a null `payment`.
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
