export interface IStockReceivePayload {
  variantId: number;
  stockLocationId?: string;
  quantity: number;
  actorId?: string;
  correlationId?: string;
}
