import { ICorrelationPayload } from '../../microservices';

// **`stockLocationId` is required here, unlike on `ICommitSaleLine`** — goods going out may fall
// back to the default warehouse, but goods coming *back* land somewhere physical, and the retail
// caller has already resolved where. There is no sensible default for a shelf.
export interface IRestockFromReturnLine {
  returnLineId: number;
  variantId: number;
  stockLocationId: string;
  quantity: number;
}

// The mirror of commit-sale: per line it **increments `quantity_on_hand`** and appends a
// strictly-positive `return` movement (ADR-032). Only `restock`-disposition lines arrive here —
// scrapped and quarantined goods never re-enter sellable inventory.
//
// **All-lines-atomic** (a partial restock never commits) and **idempotent on `returnRequestId`**:
// a `return` movement already referencing this request means the restock happened, so a redelivery
// increments nothing and replays the prior result. That matters because the retail inspect commits
// its own transaction *first* and then calls this — an RMQ retry after a successful commit is a
// normal event, not an anomaly.
//
// **The lines ride the payload rather than inventory reading retail's tables** (ADR-030 §4).
// `lines` must be non-empty. An absent `actorId` means the system acted.
export interface IRestockFromReturnPayload extends ICorrelationPayload {
  returnRequestId: number;
  lines: IRestockFromReturnLine[];
  actorId?: string | null;
}
