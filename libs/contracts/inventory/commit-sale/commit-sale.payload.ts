import { ICorrelationPayload } from '../../microservices';

// An omitted `stockLocationId` targets `INVENTORY_DEFAULT_STOCK_LOCATION`. `quantity` is a
// positive integer — the sign is applied by the ledger, not by the caller.
export interface ICommitSaleLine {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
}

// **The RPC on which stock physically leaves.** Per line it decrements **both** `quantity_on_hand`
// and `quantity_allocated` in one `StockLevel.commitSale` and appends a strictly-negative `sale`
// movement (ADR-031). Everything upstream — reserve, allocate — only moved counters around.
//
// **All-lines-atomic:** a partial ship never commits. **Idempotent on `fulfillmentId`:** a `sale`
// movement already referencing this fulfillment means the commit happened, so a redelivery
// decrements nothing and replays the prior result. That matters because the retail ship commits
// its own transaction *first* and then calls this — an RMQ retry after a successful commit is a
// normal event, not an anomaly.
//
// **The lines ride the payload rather than inventory reading retail's tables.** Inventory owns no
// view of a fulfillment and must not grow one; the caller states what it shipped (ADR-030 §4).
// `lines` must be non-empty.
export interface ICommitSalePayload extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: string;
  lines: ICommitSaleLine[];
  actorId?: string | null;
}
