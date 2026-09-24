import { ICorrelationPayload } from '../../microservices';

export interface IRetailReturnRejectedEvent extends ICorrelationPayload {
  rmaId: number;
  rmaNumber: string;
  orderId: number;
  customerId: string;
  closedAt: string;
  reason: string | null;
  eventVersion: 'v1';
  occurredAt: string;
}
