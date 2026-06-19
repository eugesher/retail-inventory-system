import { ICorrelationPayload } from '../../microservices';

// One line of a restock-from-return request: which `ReturnLine` is being
// restocked (`returnLineId` — carried so the emitted `inventory.stock.returned`
// event can name it), the variant, the concrete location the returned goods are
// being shelved at, and the positive quantity going back on-hand. The
// `stockLocationId` is required (not optional like `ICommitSaleLine`) because the
// retail caller resolves the receiving location before sending — a returned unit
// always lands at a known warehouse.
export interface IRestockFromReturnLine {
  returnLineId: number;
  variantId: number;
  stockLocationId: string;
  quantity: number;
}

// RPC payload for `inventory.stock.restock-from-return` (Retail Inspect &
// Disposition flow → Inventory). Restock physically returns a return request's
// `restock`-disposition stock to sellable inventory: per line it **increments
// `quantity_on_hand`** (one `StockLevel.changeOnHand(+quantity)`) and appends one
// strictly-positive `return` `StockMovement` referencing the return request — the
// long-reserved `return` ledger type's first producer (the mirror of ADR-031's
// `sale` from Commit Sale; ADR-030 §2 shipped the enum).
//
// It is **all-lines-atomic** (a partial restock never commits) and **idempotent
// on `returnRequestId`** — a `return` movement already referencing this request
// means the restock already happened, so a retry (a transient RMQ re-delivery
// after the retail inspect committed) increments nothing and re-returns the prior
// result. The lines ride the payload — rather than the inventory service reading
// retail's return tables — so the restock needs no cross-service read (the
// allocate / commit-sale precedent, ADR-030 §4 / ADR-031). `lines` must be
// non-empty; each `quantity` a positive integer. `actorId` (the warehouse staff
// who inspected) is null for a system actor. Extends `ICorrelationPayload`; this
// interface doubles as the `RestockFromReturnUseCase` input shape.
export interface IRestockFromReturnPayload extends ICorrelationPayload {
  returnRequestId: number;
  lines: IRestockFromReturnLine[];
  actorId?: string | null;
}
