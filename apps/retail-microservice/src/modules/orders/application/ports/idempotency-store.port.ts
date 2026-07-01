import { ITransactionScope } from './transaction.port';

// The request-level idempotency store for the retail write surface — the backing
// store the money- and stock-moving HTTP writes (place order, capture payment, ship
// fulfillment, issue refund) dedup against (docs/adr/036-idempotency-key-store-and-enforced-occ.md).
// Place Order already accepts an `Idempotency-Key` header but, before this store
// existed, only logged it; this port is what lets a use case actually replay a prior
// response instead of re-executing a money move
// (docs/adr/028-cart-order-payment-and-address-chain.md).
//
// Framework-free: domain-typed records only, no TypeORM / Nest leak past the adapter
// (ADR-017). The `save` overload accepts an optional `ITransactionScope` so a use case
// MAY persist the idempotency record inside the same transaction as its write (the
// repo's scope-aware-method precedent — `RefundTypeormRepository.save`); whether a
// given operation persists in-band is decided per-op by the wiring tasks.

export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

// A stored-response record. `requestFingerprint` is the SHA-256 hex of the
// canonicalized request body (the fingerprint utility lands separately); a replay must
// match it or the reuse is a client error. `responseStatus` / `responseBody` are the
// captured response returned verbatim on a replay. `createdAt` / `expiresAt` are
// DB-side timestamps — `expiresAt = createdAt + IDEMPOTENCY_KEY_TTL_HOURS`, the horizon
// the scheduled purge sweep deletes past.
export interface IIdempotencyRecord {
  readonly scope: string;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly responseStatus: number;
  readonly responseBody: Record<string, unknown>;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

// The shape a caller hands `save` — the persisted columns minus the DB-computed
// `createdAt` (defaulted) and `expiresAt` (derived from the injected TTL).
export interface IIdempotencyRecordInput {
  readonly scope: string;
  readonly key: string;
  readonly requestFingerprint: string;
  readonly responseStatus: number;
  readonly responseBody: Record<string, unknown>;
}

export interface IIdempotencyStorePort {
  // Load a prior record for `(scope, key)`, or `null` when none exists. It does NOT
  // filter by expiry — the scheduled purge sweep is the sole authority that removes
  // expired rows, so a not-yet-swept past-`expiresAt` row is still returned (and served
  // as an idempotent replay). This keeps the read path query-simple and all TTL logic
  // in one place.
  find(scope: string, key: string): Promise<IIdempotencyRecord | null>;

  // Insert the record, computing `expires_at` from the injected
  // `IDEMPOTENCY_KEY_TTL_HOURS`. A duplicate-PK collision on `(scope, key)` — a
  // concurrent first-writer that raced this insert in — is swallowed as a no-op (never
  // throws), the defined outcome that lets the caller fall back to `find` and serve the
  // race-winner's stored response as a replay (the `reservation` / `domain_event`
  // ER_DUP_ENTRY-translation precedent). The optional `scope` joins the caller's
  // transaction when the record is persisted in-band with the write.
  save(record: IIdempotencyRecordInput, scope?: ITransactionScope): Promise<void>;
}
