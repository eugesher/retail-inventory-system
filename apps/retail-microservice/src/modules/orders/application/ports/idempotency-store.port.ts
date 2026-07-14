import { ITransactionScope } from '@retail-inventory-system/ddd';

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

// --- Reserve-first flow (ADR-036 concurrency hardening) ---
// The `find → work → save` flow above is safe for retries but NOT for a truly
// concurrent same-key double-submit: two racers both `find` a miss and both execute
// before either `save`s. Place / capture / ship each have a *second* serializing guard
// (the cart-conversion CAS, the payment-state + order OCC, the `SELECT … FOR UPDATE`),
// so a redundant concurrent run is at worst a benign idempotent gateway op. **Refund has
// no such guard and the gateway refund is not naturally idempotent**, so a concurrent
// duplicate would double-refund. Refund therefore uses the reserve-first flow below: an
// atomic INSERT of a *pending* row claims the `(scope, key)` before the gateway call, so a
// concurrent duplicate loses the PK and is turned away (`in-progress`) BEFORE it can
// refund a second time.

// The shape a caller hands `reserve` — the identity + fingerprint of a not-yet-executed
// operation. No response yet (the row is inserted `pending`, its response filled in by
// `finalize`).
export interface IIdempotencyReserveInput {
  readonly scope: string;
  readonly key: string;
  readonly requestFingerprint: string;
}

// The response captured by `finalize` on the pending row the caller reserved.
export interface IIdempotencyFinalizeInput {
  readonly scope: string;
  readonly key: string;
  readonly responseStatus: number;
  readonly responseBody: Record<string, unknown>;
}

// The outcome of a `reserve` attempt:
//  - `reserved`    — this caller won the atomic INSERT and OWNS the execution; it must run
//                    the work then `finalize` (or `release` on failure).
//  - `replay`      — a COMPLETED row already exists with a matching fingerprint; `record`
//                    carries the stored response to return verbatim (no re-execution).
//  - `in-progress` — a PENDING row exists (a concurrent request holds the key and is
//                    mid-execution) — the caller surfaces a `409` and the client retries.
//  - `mismatch`    — a row exists with a DIFFERENT fingerprint — one key reused for two
//                    bodies, a `422`.
export interface IIdempotencyReservation {
  readonly outcome: 'reserved' | 'replay' | 'in-progress' | 'mismatch';
  // Present only on `replay` — the completed stored record to return verbatim.
  readonly record?: IIdempotencyRecord;
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

  // Delete every stored-response row whose `expires_at` has passed, returning the number
  // of rows removed. This is the housekeeping counterpart to the never-expire `find`: the
  // store is live-ephemeral (ADR-036), so a scheduled sweep is the SOLE authority that
  // removes rows once their TTL horizon has elapsed. `now` is an explicit parameter (not
  // a wall-clock read inside the adapter) so the scheduled sweep passes the current
  // instant while a test can pass a future one to force deletion deterministically. The
  // underlying statement is a single bounded `DELETE … WHERE expires_at < now`, safe to
  // run concurrently with live inserts because it can only touch already-expired rows.
  deleteExpired(now: Date): Promise<number>;

  // **The concurrency-safe front door — and `find`/`save` above is the weak one.**
  //
  // `reserve` claims `(scope, key)` with an **atomic INSERT of a `pending` row**. A truly concurrent
  // second submit loses the composite-PK insert and is turned away `in-progress` **before it runs
  // any side effect**, so an out-of-process call cannot happen twice. `find`-then-`save` cannot make
  // that promise: it checks, then acts, and the window between is exactly as wide as the work.
  //
  // **Only the refund flow uses this.** Place, Ship and Capture use `find`/`save`, and each of them
  // makes an irreversible call inside that window. Anything new that charges a gateway, decrements
  // stock, or otherwise cannot be undone should start here, not there.
  //
  // See `IIdempotencyReservation` for the four outcomes.
  reserve(
    input: IIdempotencyReserveInput,
    scope?: ITransactionScope,
  ): Promise<IIdempotencyReservation>;

  // Fill in the response on a row this caller previously `reserve`d, flipping it from
  // `pending` to a completed, replayable record. Called once the reserved work has
  // succeeded. A no-op if the row is gone (a concurrent `release`/purge) — the natural
  // idempotency backstop covers that rare window.
  finalize(input: IIdempotencyFinalizeInput, scope?: ITransactionScope): Promise<void>;

  // Delete the PENDING row this caller `reserve`d, so a later retry can re-execute. Called
  // when the reserved work threw (before it could `finalize`) — otherwise the key would
  // stay `pending` until the TTL purge and block every retry with `in-progress`. Guarded
  // to touch ONLY a still-pending row, so a finalize that actually committed is never
  // removed by a spurious release.
  release(scope: string, key: string): Promise<void>;
}
