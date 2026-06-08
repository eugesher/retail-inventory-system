import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `inventory.stock.low` event published by the
// inventory microservice when a variant's on-hand quantity at a stock location
// drops at or below the configured low-stock threshold. Framework-free.
//
// Re-keyed onto the new inventory model (ADR-027): the running totals live per
// `(variantId, stockLocationId)`, so the event carries those two keys rather
// than the retired `productId` / `storageId` pair. `quantity` is the post-commit
// `StockLevel.quantityOnHand`; `threshold` is the cross-service constant
// `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`. `eventVersion` is pinned to `'v1'`; a
// breaking payload change ships as `'v2'`. `occurredAt` is an ISO-8601 string.
export interface IInventoryStockLowEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  threshold: number;
  eventVersion: 'v1';
  occurredAt: string;
}
