import { ICorrelationPayload } from '../../microservices';

export interface ICustomerConsentUpdatedEvent extends ICorrelationPayload {
  customerId: string;
  transactionalEmail: boolean;
  marketingEmail: boolean;
  marketingSms: boolean;
  dataRetentionPolicy: string;
  updatedAt: string;
  eventVersion: 'v1';
  occurredAt: string;
}
