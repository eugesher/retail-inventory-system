import { ConsentRecord } from '../../domain';

export const CUSTOMER_EVENTS_PUBLISHER = Symbol('CUSTOMER_EVENTS_PUBLISHER');

export interface IConsentUpdatedPublishInput {
  record: ConsentRecord;
  correlationId: string;
}

export interface ICustomerErasedPublishInput {
  customerId: string;
  erasedAt: Date;
  actorStaffUserId: string | null;
  correlationId: string;
}

export interface ICustomerEventsPublisherPort {
  publishConsentUpdated(input: IConsentUpdatedPublishInput): Promise<void>;

  publishErased(input: ICustomerErasedPublishInput): Promise<void>;
}
