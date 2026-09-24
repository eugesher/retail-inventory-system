import { CartLineView, CartView } from '@retail-inventory-system/contracts';

import { Cart, CartLine } from '../../domain';

export const toCartLineView = (line: CartLine): CartLineView => ({
  id: line.id!,
  variantId: line.variantId,
  quantity: line.quantity,
  unitPriceSnapshotMinor: line.unitPriceSnapshotMinor,
  currencySnapshot: line.currencySnapshot,
  lineSubtotalMinor: line.lineSubtotalMinor,
});

export const toCartView = (cart: Cart): CartView => ({
  id: cart.id!,
  customerId: cart.customerId,
  currency: cart.currency,
  status: cart.status,
  expiresAt: cart.expiresAt ? cart.expiresAt.toISOString() : null,
  version: cart.version,
  lines: cart.lines.map((line) => toCartLineView(line)),
  subtotalMinor: cart.total.subtotalMinor,
});
