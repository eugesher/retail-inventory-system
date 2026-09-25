import { ICorrelationPayload } from '../../microservices';

export interface IRetailReturnInspectedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  customerEmail?: string | null;
  customerLocale?: string | null;
  inspectedAt: string;
  restockedLineCount: number;
  eventVersion: 'v1';
  occurredAt: string;
}
