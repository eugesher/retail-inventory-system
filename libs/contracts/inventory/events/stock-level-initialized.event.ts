import { ICorrelationPayload } from '../../microservices';

// `inventory.stock-level.initialized` — a **reserved surface** (README §2). Not dead code.
//
// Raised by the catalog-events consumer when a variant is seen for the first time: it creates a
// **zeroed** `stock_level` row at the default warehouse. The row's existence therefore says
// nothing about availability — a consumer must not read this as "stock arrived".
export interface IInventoryStockLevelInitializedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  eventVersion: 'v1';
  occurredAt: string;
}
