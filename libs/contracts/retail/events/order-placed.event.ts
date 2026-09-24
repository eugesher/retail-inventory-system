import { ICorrelationPayload } from '../../microservices';

export interface IRetailOrderPlacedEvent extends ICorrelationPayload {
  orderId: number;
  orderNumber: string;
  customerId: string | null;
  customerEmail?: string | null;
  customerLocale?: string | null;
  grandTotalMinor: number;
  currency: string;
  lineCount: number;
  eventVersion: 'v1';
  occurredAt: string;
}
