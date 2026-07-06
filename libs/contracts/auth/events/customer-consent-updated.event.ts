import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `customer.consent.updated` event, published by the
// api-gateway `auth` module after a customer's channel-consent record is written
// (the Record Consent flow). Framework-free — a domain object is never serialized
// across services (ADR-011); the consent publisher maps the persisted
// `ConsentRecord` onto this interface before emitting.
//
// It is emitted onto `notification_events` (the producer-targets-consumer-queue
// pattern, ADR-008/020) so the notification service's consent cache can refresh
// itself from the event WITHOUT a per-refresh cross-service RPC — the payload
// therefore carries the **full** consent snapshot, not just the customer id. The
// same routing key + payload is additionally mirrored onto the `ris.events` topic
// exchange (ADR-035) so the event-store firehose captures it. Both destinations
// are best-effort post-commit.
//
// `updatedAt` is the ISO-8601 timestamp of the write (the DB-stamped
// `consent_record.updated_at`). `eventVersion` is pinned to `'v1'`; a breaking
// change ships `'v2'`. `occurredAt` is an ISO-8601 string (the emit instant).
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
