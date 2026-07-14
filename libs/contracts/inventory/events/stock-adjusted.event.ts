import { ICorrelationPayload } from '../../microservices';

// `inventory.stock.adjusted` — a **reserved surface** (README §2). Not dead code.
//
// `quantityDelta` is **signed**: an adjustment is the one movement type that may go either way.
//
// `reasonCode` is mandatory, and it rides the wire as well as the `adjustment` `StockMovement` row
// the use case appends in the same transaction (ADR-030) — so a consumer knows *why* the delta
// happened without joining the ledger to find out.
export interface IInventoryStockAdjustedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantityDelta: number;
  reasonCode: string;
  newOnHand: number;
  actorId?: string;
  eventVersion: 'v1';
  occurredAt: string;
}
