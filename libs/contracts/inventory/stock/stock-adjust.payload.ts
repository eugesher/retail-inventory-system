export interface IStockAdjustPayload {
  variantId: number;
  stockLocationId?: string;
  quantityDelta: number;
  reasonCode: string;
  actorId?: string;
  correlationId?: string;
}
