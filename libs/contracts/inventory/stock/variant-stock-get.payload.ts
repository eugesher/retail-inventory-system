// RPC payload for `inventory.stock-level.get` (API Gateway → Inventory). Asks
// for the availability projection of one catalog variant, optionally scoped to a
// subset of stock locations (omit `stockLocationIds` for every location).
//
// `correlationId` is **optional** on the wire — it does not extend the required
// `ICorrelationPayload` because a direct RMQ caller may omit it; the gateway
// threads it through when present.
export interface IVariantStockGetPayload {
  variantId: number;
  stockLocationIds?: string[];
  correlationId?: string;
}
