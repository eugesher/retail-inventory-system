import { OrderFulfillmentStatusEnum, OrderStatusEnum } from '@retail-inventory-system/contracts';

export const RETURN_ORDER_READER = Symbol('RETURN_ORDER_READER');

// A flat read projection of one line of the order a return is being opened against —
// just enough for the Open use case's returnable-quantity check. `orderLineId` is the
// line the returned units point back at; `variantId` the opaque catalog backbone key
// (carried so a later restock can address the variant); `quantity` the ordered quantity;
// `cancelledQuantity` how many of those units were cancelled (so they are not returnable).
// It is deliberately NOT the order domain's `OrderLine` — the returns module cannot import
// the orders module's `Order` / `IOrderRepositoryPort` (the boundaries lint forbids the
// cross-module import, ADR-004 / ADR-017). The orders module is a sibling behind a hard
// isolation line.
export interface IReturnOrderLineSnapshot {
  orderLineId: number;
  variantId: number;
  quantity: number;
  cancelledQuantity: number;
}

// A flat read projection of the order header + lines, just enough for Open: the
// owner-check (`customerId`), the return-eligibility gate (`status` /
// `fulfillmentStatus` + the `shippedAt` / `deliveredAt` timestamps the window is measured
// from), and the per-line returnable math (`lines`). Like the line snapshot it is NOT the
// order aggregate — a flat read shape the raw-SQL adapter assembles.
//
// `shippedAt` / `deliveredAt` are rolled up from the order's `fulfillment` rows
// (`MIN(shipped_at)` — the first ship; `MAX(delivered_at)` — the last delivery), null when
// the order has not yet shipped / been delivered. The window is measured from `shippedAt`;
// a `delivered` order is always returnable (ADR-032).
export interface IReturnOrderSnapshot {
  orderId: number;
  customerId: string | null;
  status: OrderStatusEnum;
  fulfillmentStatus: OrderFulfillmentStatusEnum;
  shippedAt: Date | null;
  deliveredAt: Date | null;
  lines: IReturnOrderLineSnapshot[];
}

// The returns context's seam onto the `order` / `order_line` (+ `fulfillment`) tables —
// the only way the Open use case reaches the order it is returning against. Its adapter
// reads those tables with PARAMETERIZED SQL through the injected `EntityManager`, never
// importing the orders module's entities (the exact cross-module precedent the orders
// module uses for the cart tables via `ORDER_CART_READER`, and pricing for the
// catalog-owned `product_variant.tax_category_id` — ADR-004 / ADR-017 / ADR-028 / ADR-032).
// The opaque shared FKs (`order.id` / `order_line.order_id`) are the only coupling.
//
// `findOrderForReturn` resolves the snapshot (read-only, outside any transaction); a
// missing order is `null` (the Open use case maps that to `RETURN_ORDER_NOT_FOUND`).
// Domain/contract types only — no `typeorm` leak (ADR-017). The already-returned-quantity
// sum is NOT here: it is computed in the Open use case from
// `RETURN_REQUEST_REPOSITORY.listByOrderId` (excluding rejected RMAs), keeping this reader
// focused on the orders tables alone.
export interface IReturnOrderReaderPort {
  findOrderForReturn(orderId: number): Promise<IReturnOrderSnapshot | null>;
}
