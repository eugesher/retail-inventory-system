import { ConsentRecord } from '../../domain';

export const CONSENT_RECORD_REPOSITORY = Symbol('CONSENT_RECORD_REPOSITORY');

// A separate per-aggregate repository seam (the `ACTIVE_PRICE_PROBE` /
// `CATEGORY_REPOSITORY` precedent) — `ConsentRecord` is its own persistence
// concern, keyed 1:1 on the customer's CHAR(36) UUID, so it gets its own port
// rather than crowding `CUSTOMER_REPOSITORY`.
export interface IConsentRecordRepositoryPort {
  // Returns the stored row, or null when the customer has no explicit consent
  // yet — the caller resolves a null to `ConsentRecord.default(customerId)`
  // (absent-row-means-defaults).
  findByCustomerId(customerId: string): Promise<ConsentRecord | null>;

  // INSERT-or-update upsert keyed on `customer_id`: creates the row on first
  // write, overwrites the channel flags + retention policy on subsequent writes.
  // Returns the persisted record (re-read, so `updatedAt` is the DB-stamped value).
  save(record: ConsentRecord): Promise<ConsentRecord>;
}
