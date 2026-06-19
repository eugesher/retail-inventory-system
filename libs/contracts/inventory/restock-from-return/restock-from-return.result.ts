// One restocked line in an `inventory.stock.restock-from-return` result: the
// `ReturnLine` it restocked, the variant, the location it was shelved at, and the
// quantity that went back on-hand. `returnLineId` is echoed so the retail caller
// can correlate each restocked line back to the return it inspected.
export interface IRestockFromReturnResultEntry {
  returnLineId: number;
  variantId: number;
  stockLocationId: string;
  quantity: number;
}

// Result of `inventory.stock.restock-from-return`: the lines that were restocked,
// in request order. Because restock is all-lines-atomic, this is either the full
// set (the whole return restocked) or the call rejected and nothing restocked. On
// the idempotent-replay path it re-returns the same set without incrementing again.
export interface IRestockFromReturnResult {
  restocked: IRestockFromReturnResultEntry[];
}
