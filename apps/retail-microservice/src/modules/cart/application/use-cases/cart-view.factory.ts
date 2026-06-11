import { CartLineView, CartView } from '@retail-inventory-system/contracts';

import { Cart, CartLine } from '../../domain';

// Pure mapping from the cart domain onto its wire view, shared by every cart use
// case so the projection lives in exactly one place (the catalog
// `catalog-view.factory` pattern). Framework-free — no Nest decorators.
//
// A live cart (created or reconstituted) always carries a concrete id, and a line
// returned from the repository carries its persisted BIGINT id, so the `!`
// assertions are safe here (the same non-null assertion the catalog factory
// makes on `product.id`).
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
