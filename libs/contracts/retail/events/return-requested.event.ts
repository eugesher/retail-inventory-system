import { ICorrelationPayload } from '../../microservices';

export interface IRetailReturnRequestedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  customerEmail?: string | null;
  customerLocale?: string | null;
  requestedAt: string;
  lineCount: number;
  eventVersion: 'v1';
  occurredAt: string;
}
