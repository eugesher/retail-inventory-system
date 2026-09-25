import { ICorrelationPayload } from '../../microservices';

export interface IRetailReturnClosedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  closedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
