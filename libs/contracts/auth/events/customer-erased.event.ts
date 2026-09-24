import { ICorrelationPayload } from '../../microservices';

export interface ICustomerErasedEvent extends ICorrelationPayload {
  customerId: string;
  erasedAt: string;
  actorStaffUserId: string | null;
  eventVersion: 'v1';
  occurredAt: string;
}
