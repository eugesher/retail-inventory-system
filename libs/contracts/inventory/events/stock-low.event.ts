import { ICorrelationPayload } from '../../microservices';

export interface IInventoryStockLowEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  threshold: number;
  eventVersion: 'v1';
  occurredAt: string;
}
