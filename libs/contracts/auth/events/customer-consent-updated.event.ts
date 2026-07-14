import { ICorrelationPayload } from '../../microservices';

// `customer.consent.updated` — emitted onto `notification_events`, where the consent-cache consumer
// binds it (ADR-008/020), and mirrored onto `ris.events` for the firehose.
//
// **The payload carries the FULL consent snapshot, not just the customer id, and that is the
// point.** The notification service's consent cache refreshes itself write-through from this
// event; if the payload carried only an id, every consent change would cost a cross-service RPC on
// the notification hot path. Adding a field here is cheap; making the consumer ask for one is not.
//
// `updatedAt` is the DB-stamped `consent_record.updated_at`, not the emit instant — that is
// `occurredAt`.
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
