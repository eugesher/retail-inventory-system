import { ICorrelationPayload } from '../../microservices';

export interface IInventoryStockCommittedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  orderId: number;
  fulfillmentId: string;
  eventVersion: 'v1';
  occurredAt: string;
}
