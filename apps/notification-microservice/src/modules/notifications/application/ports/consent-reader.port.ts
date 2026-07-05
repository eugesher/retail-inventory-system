export const CONSENT_READER = Symbol('CONSENT_READER');

// A small, framework-free snapshot of one customer's channel-consent — exactly the
// fields the Render & Dispatch consent-gate needs to decide send vs
// `skipped-no-consent` (ADR-037), plus the free-form retention policy carried for
// completeness (the cache write-through mirrors the full `customer.consent.updated`
// event snapshot). The three flags map 1:1 onto the shared `consent_record` columns:
//   - `transactionalEmail`  — gates transactional email (order confirmations, …).
//   - `marketingEmail`      — gates marketing email.
//   - `marketingSms`        — gates marketing sms.
export interface IConsentSnapshot {
  transactionalEmail: boolean;
  marketingEmail: boolean;
  marketingSms: boolean;
  dataRetentionPolicy: string;
}

// Absent-row-means-defaults (ADR-037): a customer who has never written a consent
// record resolves to these — transactional email allowed (the bypass the gate
// honors), both marketing channels denied (opt-in, the GDPR posture). The cache
// returns this when the reader yields `null`, AND the cache-aside layer falls back to
// it if the reader itself errors — so a transactional dispatch is never blocked by a
// consent-store hiccup while a marketing one stays safely suppressed. The retention
// policy default string is duplicated here (not imported from the gateway `auth`
// module's `ConsentRecord`, a hard cross-service isolation line) — the two agreeing on
// `default-7-years` is a documented convention, not a shared symbol.
export const DEFAULT_CONSENT: IConsentSnapshot = {
  transactionalEmail: true,
  marketingEmail: false,
  marketingSms: false,
  dataRetentionPolicy: 'default-7-years',
};

// The notification context's read seam onto the shared `consent_record` table. Its
// adapter reads the table with PARAMETERIZED SQL through the injected `EntityManager`,
// never importing the gateway `auth` module's `ConsentRecordEntity` — the exact
// cross-context precedent `ORDER_CART_READER` uses for the retail `cart` tables
// (ADR-017 / ADR-026 §5). The opaque shared key (`consent_record.customer_id`) is the
// only coupling. `load` returns the snapshot for a present row, or `null` for an absent
// one (the cache-aside layer maps `null` → `DEFAULT_CONSENT`). Domain types only — no
// `typeorm` leak past the adapter.
export interface IConsentReaderPort {
  load(customerId: string): Promise<IConsentSnapshot | null>;
}
