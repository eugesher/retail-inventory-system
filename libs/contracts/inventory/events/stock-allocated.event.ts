import { ICorrelationPayload } from '../../microservices';

export interface IInventoryStockAllocatedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  quantity: number;
  orderId: number;
  reservationId: string | null;
  eventVersion: 'v1';
  occurredAt: string;
}
