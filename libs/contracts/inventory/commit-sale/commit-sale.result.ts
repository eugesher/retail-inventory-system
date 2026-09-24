export interface ICommitSaleResultEntry {
  variantId: number;
  stockLocationId: string;
  quantity: number;
}

export interface ICommitSaleResult {
  committed: ICommitSaleResultEntry[];
}
