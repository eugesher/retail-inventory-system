import { ICorrelationPayload } from '../../microservices';

export interface IRetailReturnReceivedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  customerEmail?: string | null;
  customerLocale?: string | null;
  receivedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
