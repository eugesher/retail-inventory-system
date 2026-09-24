import { ICorrelationPayload } from '../../microservices';

export interface IRetailFulfillmentShippedEvent extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  customerEmail?: string | null;
  customerLocale?: string | null;
  trackingNumber: string;
  carrier: string | null;
  shippedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
