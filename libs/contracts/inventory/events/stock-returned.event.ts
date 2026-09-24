import { ICorrelationPayload } from '../../microservices';

export interface IInventoryStockReturnedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  returnRequestId: number;
  returnLineId: number;
  eventVersion: 'v1';
  occurredAt: string;
}
