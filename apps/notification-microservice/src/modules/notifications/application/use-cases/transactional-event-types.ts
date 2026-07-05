// The set of event types whose seeded templates are **transactional** — messages a
// customer is entitled to receive regardless of their marketing opt-in (an order
// confirmation, a shipment notice, a refund receipt, …). The Render & Dispatch
// consent-gate (ADR-037) classifies an email dispatch as transactional iff its
// `eventType` is in this set, gating it on `consent.transactionalEmail` (default
// true); an email `eventType` NOT in this set is **marketing**, gated on
// `consent.marketingEmail` (default false). An sms dispatch is always treated as
// marketing (`consent.marketingSms`).
//
// These string literals are the `ROUTING_KEYS` VALUES the notification consumers pass
// as `eventType`. They are inlined (not imported from `@retail-inventory-system/messaging`)
// because the application layer must not depend on `lib-messaging` (the boundaries
// rule, ADR-017) — the consumers own the routing-key → `eventType` mapping, and this
// table classifies the resulting string. `inventory.stock.low` is deliberately absent:
// it is an OPS alert with a null recipient, so it is never consent-gated at all (the
// gate skips null-recipient dispatches before it ever classifies them).
//
// Anything NOT listed here — including the marketing seam's `marketing.email.promo`
// (and any future `marketing.*` campaign type) — is marketing by definition.
export const TRANSACTIONAL_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  'retail.order.placed',
  'retail.order.cancelled',
  'retail.fulfillment.shipped',
  'retail.fulfillment.delivered',
  'retail.refund.issued',
  'retail.return.requested',
  'retail.return.authorized',
  'retail.return.received',
  'retail.return.inspected',
]);
