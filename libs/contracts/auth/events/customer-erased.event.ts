import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `customer.erased` event, published by the api-gateway
// `auth` module after a customer is tombstone-erased (their PII nulled, `status`
// flipped to `deleted`). Framework-free — a domain object is never serialized
// across services (ADR-011).
//
// It is emitted onto `notification_events` (so the notification consent cache can
// evict the erased customer's entry) and mirrored onto the `ris.events` topic
// exchange (so the event-store firehose captures it), both best-effort post-commit
// (ADR-035).
//
// **This event carries NO PII by design** — only `customerId`, the erase instant,
// and the acting staff user. The whole purpose of the erase is to destroy the
// customer's personal data, so the event that *announces* the erase must never let
// a downstream reconstruct the identity that was just erased. The event outlives
// the PII (the firehose is an append-only log), so putting an email or name on it
// would defeat the erasure at the exact moment it happens. A consumer that needs
// to act on the erased customer keys off `customerId` alone.
//
// `erasedAt` is the ISO-8601 erase instant (mirrors `customer.deleted_at`).
// `actorStaffUserId` is the staff user who performed the erase, or null for a
// system-initiated erase. `eventVersion` is pinned to `'v1'`; `occurredAt` is the
// ISO-8601 emit instant.
export interface ICustomerErasedEvent extends ICorrelationPayload {
  customerId: string;
  erasedAt: string;
  actorStaffUserId: string | null;
  eventVersion: 'v1';
  occurredAt: string;
}
