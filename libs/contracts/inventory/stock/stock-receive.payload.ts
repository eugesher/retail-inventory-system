// RPC payload for `inventory.stock-level.receive` (API Gateway → Inventory). A
// Receive Stock operation raises a variant's on-hand quantity at one stock
// location by a positive `quantity` (ADR-027).
//
// `stockLocationId` is optional — omit it to target the default warehouse
// (`INVENTORY_DEFAULT_STOCK_LOCATION`). `actorId` is the staff user performing
// the receive (threaded from the gateway's `@CurrentUser()`); it rides into the
// emitted `inventory.stock.received` event and the logs. `correlationId` is
// **optional** on the wire — it does not extend the required `ICorrelationPayload`
// because a direct RMQ caller may omit it; the gateway threads it through when
// present. This interface doubles as the `ReceiveStockUseCase` input shape.
export interface IStockReceivePayload {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
  actorId?: string;
  correlationId?: string;
}
