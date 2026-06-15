// One shipped line in an `inventory.stock.commit-sale` result: the variant, the
// resolved location (always concrete — the default was applied at the edge), and
// the quantity that was committed to a sale (moved out of on-hand + allocated).
export interface ICommitSaleResultEntry {
  variantId: number;
  stockLocationId: string;
  quantity: number;
}

// Result of `inventory.stock.commit-sale`: the lines that were committed, in
// request order. Because commit-sale is all-lines-atomic, this is either the full
// set (the whole shipment committed) or the call rejected and nothing committed.
// On the idempotent-replay path it re-returns the same set without decrementing
// again.
export interface ICommitSaleResult {
  committed: ICommitSaleResultEntry[];
}
