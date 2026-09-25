import { ICorrelationPayload } from '../../microservices';

export interface IRetailReturnAuthorizedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  customerEmail?: string | null;
  customerLocale?: string | null;
  authorizedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
