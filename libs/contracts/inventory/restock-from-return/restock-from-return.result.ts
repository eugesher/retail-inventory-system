export interface IRestockFromReturnResultEntry {
  returnLineId: number;
  variantId: number;
  stockLocationId: string;
  quantity: number;
}

export interface IRestockFromReturnResult {
  restocked: IRestockFromReturnResultEntry[];
}
