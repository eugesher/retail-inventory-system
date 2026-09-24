import { ICorrelationPayload } from '../../microservices';

export interface IInventoryStockAdjustedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantityDelta: number;
  reasonCode: string;
  newOnHand: number;
  actorId?: string;
  eventVersion: 'v1';
  occurredAt: string;
}
