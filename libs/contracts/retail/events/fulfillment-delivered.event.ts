import { ICorrelationPayload } from '../../microservices';

export interface IRetailFulfillmentDeliveredEvent extends ICorrelationPayload {
  orderId: number;
  fulfillmentId: number;
  customerEmail?: string | null;
  customerLocale?: string | null;
  deliveredAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
