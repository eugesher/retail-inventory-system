import { ICorrelationPayload } from '../../microservices';

// `inventory.stock.returned` — a **reserved surface** (README §2). Not dead code.
//
// A typed alias for the positive `return`-type movement, given its own routing key so a consumer
// can filter returned stock without scanning every `inventory.stock-movement.recorded`. Only
// `restock`-disposition lines get here — scrapped and quarantined goods never re-enter sellable
// inventory and raise no event.
//
// `returnRequestId` is the idempotency anchor: the restock is all-lines-atomic and replaying it
// for the same RMA is a no-op (ADR-032).
export interface IInventoryStockReturnedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  returnRequestId: number;
  returnLineId: number;
  eventVersion: 'v1';
  occurredAt: string;
}
