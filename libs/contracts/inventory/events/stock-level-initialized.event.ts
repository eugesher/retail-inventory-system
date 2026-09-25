import { ICorrelationPayload } from '../../microservices';

export interface IInventoryStockLevelInitializedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  eventVersion: 'v1';
  occurredAt: string;
}
