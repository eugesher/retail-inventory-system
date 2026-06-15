import { ICorrelationPayload } from '../../microservices';

// One line of a commit-sale request: the variant, the location (optional — omit
// to target `INVENTORY_DEFAULT_STOCK_LOCATION`), and the positive quantity being
// shipped. Mirrors `IAllocationLine` (the allocate/cancel line shape) so the
// order-side inventory operations stay shape-aligned.
export interface ICommitSaleLine {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
}

// RPC payload for `inventory.stock.commit-sale` (Retail ship flow → Inventory).
// Commit Sale physically ships an order's allocated stock at fulfillment time
// (ADR-031): per line it moves units OUT of BOTH `quantity_on_hand` and
// `quantity_allocated` (the allocated stock physically leaving) in one
// `StockLevel.commitSale`, and appends one strictly-negative `sale`
// `StockMovement` referencing the fulfillment.
//
// It is **all-lines-atomic** (a partial ship never commits) and **idempotent on
// `fulfillmentId`** — a `sale` movement already referencing this fulfillment means
// the commit already happened, so a retry (a transient RMQ re-delivery after the
// retail ship committed) decrements nothing and re-returns the prior result. The
// lines ride the payload — rather than the inventory service reading retail's
// fulfillment tables — so the commit needs no cross-service read (the allocate
// precedent, ADR-030 §4). `lines` must be non-empty; each `quantity` a positive
// integer; an omitted `stockLocationId` targets `INVENTORY_DEFAULT_STOCK_LOCATION`.
// Extends `ICorrelationPayload`; this interface doubles as the `CommitSaleUseCase`
// input shape.
export interface ICommitSalePayload extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: string;
  lines: ICommitSaleLine[];
  actorId?: string | null;
}
