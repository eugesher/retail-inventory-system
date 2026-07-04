import { ConsentRecord } from '../../domain';

export const CUSTOMER_EVENTS_PUBLISHER = Symbol('CUSTOMER_EVENTS_PUBLISHER');

// The domain-typed input for a `customer.consent.updated` emit. The use case
// passes the persisted `ConsentRecord` (so `updatedAt` is the DB-stamped value)
// plus the request `correlationId`; the adapter maps it onto the
// `ICustomerConsentUpdatedEvent` wire shape and stamps `occurredAt`.
export interface IConsentUpdatedPublishInput {
  record: ConsentRecord;
  correlationId: string;
}

// The domain-typed input for a `customer.erased` emit. NO PII — only the ids and
// the erase instant (the adapter builds the no-PII `ICustomerErasedEvent` wire
// shape). The erase flow (a later change) is the only caller.
export interface ICustomerErasedPublishInput {
  customerId: string;
  erasedAt: Date;
  actorStaffUserId: string | null;
  correlationId: string;
}

// The customer-privacy event publisher seam (ADR-035). The two `customer.*`
// events ride `notification_events` (for the notification consumers) and are
// mirrored onto `ris.events` (for the event-store firehose); both destinations are
// best-effort post-commit. The port keeps the use cases free of `ClientProxy` and
// of the wire-event shapes (ADR-009) — the adapter owns both.
export interface ICustomerEventsPublisherPort {
  // Emits `customer.consent.updated` carrying the full consent snapshot.
  publishConsentUpdated(input: IConsentUpdatedPublishInput): Promise<void>;

  // Emits `customer.erased` — ids + `erasedAt` only, never PII.
  publishErased(input: ICustomerErasedPublishInput): Promise<void>;
}
