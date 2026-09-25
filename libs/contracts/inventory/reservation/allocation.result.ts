export interface IAllocationResultEntry {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  reservationId: string | null;
}

export interface IAllocationResult {
  allocated: IAllocationResultEntry[];
}
