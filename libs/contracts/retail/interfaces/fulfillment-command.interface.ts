import { ICorrelationPayload } from '../../microservices';

// Wire-format command payloads for the fulfillment RPCs (API Gateway → Retail,
// served by the orders controller — a fulfillment is a sibling aggregate in the
// orders module, ADR-031). Each extends `ICorrelationPayload` so the correlation id
// threads through to the retail handler's inline logging (ADR-001 / ADR-011). They
// are the single source of truth for both ends: the gateway adapter sends them and
// the retail fulfillment use cases consume them as their `execute(payload)` input, so
// a drift fails TypeScript on both sides (the contract test).
//
// **Authorization is split across the boundary (ADR-024 / ADR-028 §7).** The customer
// is never permission-gated for its own orders — the route is bearer-protected and
// the retail use case owner-checks `order.customerId === actorId`. The staff override
// is computed at the gateway from `@CurrentUser().permissions` and forwarded here as a
// boolean (`isStaffFulfill` for `order:fulfill`, `canReadAny` for `order:read`), so
// the retail use case never re-reads the permission registry — it trusts the resolved
// flag. `actorId` is the resolved caller (`@CurrentUser().id`).

// `retail.fulfillment.create` — plans a shipment of one or more `OrderLine`
// quantities (owner-checked, or a staff `order:fulfill` override via `isStaffFulfill`).
// `stockLocationId` is optional — the use case defaults it to `default-warehouse`
// (`INVENTORY_DEFAULT_STOCK_LOCATION`); multi-location sourcing is a later capability.
// `lines` carry the per-`OrderLine` quantities included in this shipment; the use case
// enforces the cross-fulfillment sum invariant (already-fulfilled + requested ≤
// ordered) before persisting.
export interface IRetailFulfillmentCreatePayload extends ICorrelationPayload {
  orderId: number;
  stockLocationId?: string;
  lines: { orderLineId: number; quantity: number }[];
  actorId: string;
  isStaffFulfill: boolean;
}

// `retail.fulfillment.list` — lists one order's fulfillments newest-first
// (owner-checked, or a staff `order:read` override via `canReadAny`). An order with no
// fulfillments resolves to an empty array.
export interface IRetailFulfillmentListPayload extends ICorrelationPayload {
  orderId: number;
  actorId: string;
  canReadAny: boolean;
}

// `retail.fulfillment.ship` — ships a `pending` fulfillment (owner-checked, or a staff
// `order:fulfill` override via `isStaffFulfill`). The ship captures an authorized
// payment inline (Q5 ship-triggered capture — blocked if the gateway declines),
// advances the fulfillment → `shipped` (`trackingNumber` is required to mark it
// shipped — the tracking-on-ship policy), the order's fulfillment axis + the shipped
// `OrderLine` statuses, then calls `inventory.stock.commit-sale` after the local
// commit (ADR-031). `trackingNumber` / `carrier` are the shipment metadata;
// `idempotencyKey` is accepted + logged but not deduped (the cart-state idempotency
// analogue — a non-`pending` re-ship is a 409). `actorId` is the resolved caller.
export interface IRetailFulfillmentShipPayload extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  trackingNumber?: string;
  carrier?: string;
  idempotencyKey?: string;
  actorId: string;
  isStaffFulfill: boolean;
}
