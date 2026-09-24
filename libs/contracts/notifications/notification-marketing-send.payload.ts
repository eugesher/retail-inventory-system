import { ICorrelationPayload } from '../microservices';

export interface INotificationMarketingSendPayload extends ICorrelationPayload {
  customerId: string;
  customerEmail: string;
  eventType: string;
  campaignId: string;
  context: Record<string, unknown>;
}
