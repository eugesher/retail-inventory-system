import { ICorrelationPayload } from '../../microservices';

export interface IRetailFulfillmentCreatedEvent extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  stockLocationId: string;
  lineQuantities: { orderLineId: number; quantity: number }[];
  eventVersion: 'v1';
  occurredAt: string;
}
