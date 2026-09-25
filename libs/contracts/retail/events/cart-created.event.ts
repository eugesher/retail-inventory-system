import { ICorrelationPayload } from '../../microservices';

export interface IRetailCartCreatedEvent extends ICorrelationPayload {
  cartId: string;
  customerId: string | null;
  currency: string;
  eventVersion: 'v1';
  occurredAt: string;
}
