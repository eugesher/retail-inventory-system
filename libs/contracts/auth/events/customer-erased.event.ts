import { ICorrelationPayload } from '../../microservices';

// `customer.erased` — raised after a customer is tombstone-erased: PII nulled in place, `status`
// flipped to `deleted`, the row kept so orders do not lose their owner (ADR-037).
//
// It goes to `notification_events`, where the consent-cache consumer evicts the erased customer's
// entry, and is mirrored onto `ris.events` for the firehose.
//
// **This event carries NO PII, and it must never grow any.** The erase exists to destroy the
// customer's personal data; an event *announcing* the erase that carried an email would hand a
// downstream the identity that was just destroyed. Worse, **the event outlives the data** — the
// firehose is an append-only log — so a name on this payload defeats the erasure permanently, at
// the exact moment it is supposed to take effect. A consumer that needs to act on the erased
// customer keys off `customerId` and nothing else.
//
// `actorStaffUserId` is `null` for a system-initiated erase.
export interface ICustomerErasedEvent extends ICorrelationPayload {
  customerId: string;
  erasedAt: string;
  actorStaffUserId: string | null;
  eventVersion: 'v1';
  occurredAt: string;
}
