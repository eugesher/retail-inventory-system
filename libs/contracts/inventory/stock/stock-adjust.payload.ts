// RPC payload for `inventory.stock-level.adjust` (API Gateway → Inventory). An
// Adjust Stock operation applies a signed `quantityDelta` to a variant's on-hand
// quantity at one stock location, with a mandatory `reasonCode` (ADR-027). A
// result that would go below zero is rejected (surfaced as a 409 at the gateway).
//
// `stockLocationId` is optional — omit it to target the default warehouse
// (`INVENTORY_DEFAULT_STOCK_LOCATION`). `reasonCode` is **mandatory and
// non-empty** — it is the audit reason carried on the wire, in the emitted
// `inventory.stock.adjusted` event, and in logs (no `StockMovement` row is
// written today; that audit log lands with a later capability). `actorId` is the
// staff user performing the adjustment (threaded from the gateway's
// `@CurrentUser()`). `correlationId` is **optional** on the wire (a direct RMQ
// caller may omit it). This interface doubles as the `AdjustStockUseCase` input
// shape.
export interface IStockAdjustPayload {
  variantId: number;
  stockLocationId?: string;
  quantityDelta: number;
  reasonCode: string;
  actorId?: string;
  correlationId?: string;
}
