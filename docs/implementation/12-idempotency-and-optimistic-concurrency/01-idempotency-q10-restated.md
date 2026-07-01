# Request-level idempotency: the requirement

A retail checkout moves money and stock. Placing an order authorizes a payment
and allocates inventory; capturing charges the card; shipping commits the sale;
issuing a refund returns funds. Each of these reaches the system as a single HTTP
call — and HTTP calls are not reliable exactly-once deliveries. A client can time
out and retry, a user can double-click "Pay", a mobile connection can drop after
the server committed but before the response arrived. Downstream, the message bus
between the gateway and the microservices is **at-least-once**
([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)), so even a single
inbound HTTP request can turn into a redelivered RPC.

Without protection, the same *logical* write executed twice double-charges,
double-ships, or issues a second refund. **Request-level idempotency** closes that
gap: a client attaches a unique `Idempotency-Key` to a mutating call, and the
server guarantees the operation runs **at most once** for that key. The first call
executes and the server remembers its response; any later call carrying the same
key returns the remembered response *without re-executing* — and, crucially,
without re-emitting the domain events the first execution already published.

This document is the conceptual entry point for that capability. It states the
requirement, explains **where** the idempotency memory lives and why, and
describes the **body-fingerprinting** strategy that lets the server distinguish a
genuine retry from an accidental key collision. The concrete persistence
substrate is covered in
[the idempotency-key store and its TTL](02-idempotency-key-store-and-ttl.md); the
guarantee that a replay emits no duplicate events is covered in
[replay does not republish events](06-replay-does-not-republish-events.md). The
governing decision is
[ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md).

## The four covered operations

Idempotency is applied to the mutating, side-effect-heavy operations on the retail
write surface — the ones where a duplicate is expensive:

1. **Place order** (`order.place`) — authorizes payment and allocates stock.
2. **Capture payment** (`payment.capture`) — charges an authorized payment.
3. **Ship fulfillment** (`fulfillment.ship`) — captures on ship and commits the
   sale against inventory.
4. **Issue refund** (`refund.issue`) — returns funds through the payment gateway.

These are the money- and stock-moving writes; pure reads and internally-idempotent
writes do not need a stored-response guard. (Inventory's own writes are already
idempotent by natural key — see the next section — so they carry no separate
idempotency store.)

## A per-service-local store, not a shared one

The idempotency memory is a **single table owned by the retail microservice**
(`idempotency_key`, in the shared `retail_db`). It is deliberately **not** a shared
cross-service store that every service reads and writes.

Two reasons drive this:

- **Retail is where the request-level dedup need actually is.** All four covered
  operations are retail HTTP writes. Inventory's writes already have
  **natural-key idempotency** — Reserve is idempotent-by-absolute-quantity on its
  `(cart_id, variant_id, stock_location_id)` triple, and Commit-sale / Restock are
  idempotency-first on `fulfillmentId` / `returnRequestId` via the movement ledger
  ([ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)).
  A second, inventory-side idempotency table would be dead code.
- **A shared table reintroduces cross-context coupling.** Each bounded context
  owns its tables and reaches another context's data only through a reader port,
  never a shared table
  ([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)). A single
  cross-service idempotency store — the rejected alternative in
  [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) — would break
  that ownership boundary for no benefit, since retail is the only real consumer.

So the store lives next to the use cases it guards, in retail's `orders/` module.
"Per-service-local" here means *local to the producing service*: the service that
runs the operation owns the memory of whether it already ran.

## Why a fingerprint — canonical JSON + SHA-256

A key alone is not enough to serve a replay safely. Consider a client that reuses
the key `"abc"` for two genuinely different orders (a client bug, or a key
generated once and never rotated). Keyed only on `"abc"`, the server would return
the **first** order's response for the **second**, different request — silently
wrong. The fingerprint is the guard against exactly this.

Alongside each stored response the server records a **fingerprint of the request
body**: a `CHAR(64)` SHA-256 hex digest of the body in *canonical* form. When a
call arrives with a known key, the server compares fingerprints:

- **Same key + same fingerprint → replay.** Return the stored response; do not
  re-execute; emit no events. The safe retry path.
- **Same key + different fingerprint → `422`** (`IDEMPOTENCY_KEY_REUSED`). The
  client reused one key for two different bodies — surfaced loudly as a client
  error rather than silently honored with the wrong cached response.
- **Missing key on an operation that requires one → `400`**
  (`IDEMPOTENCY_KEY_REQUIRED`).

### Canonicalization

The digest must be a function of the *logical* content of the body, not of its
textual serialization. Two clients (and, internally, two layers — the gateway and
the retail service) can produce the same logical body with keys in a different
order or with different whitespace. If field order changed the hash, every
legitimate retry that happened to re-serialize its JSON differently would look
like a key-reuse `422`.

So the body is **canonicalized** before hashing:

- Object keys are sorted **recursively**, at every nesting level, so
  `{ a: 1, b: 2 }` and `{ b: 2, a: 1 }` hash identically.
- **Array order is preserved** — it is semantically significant (a reordered
  cart-line list is a different order), so it must change the digest.
- A key whose value is `undefined` is **dropped** (indistinguishable from an
  absent key); `null` is **retained** and stays distinct from both. This matches
  `JSON.stringify` semantics.
- A change to any value, a type change (`1` vs `"1"`), or an added / removed key
  changes the digest.

The canonical string is then hashed with **SHA-256**, yielding a lowercase
64-character hex digest that fits the `request_fingerprint CHAR(64)` column. This
canonical-JSON + SHA-256 helper is a small, framework-free utility (Node's
built-in `crypto` only) so both the gateway and the retail service can compute the
identical digest from the same logical body.

### What "the body" is

The fingerprint is computed over a **stable logical body**, not the raw HTTP byte
string, so that both computing sites agree. The logical body is the command
payload *minus* fields that are not part of the client's intent:

- **`correlationId`** — a per-request tracing id that changes on every retry; it is
  observability metadata, not request content, and including it would make every
  retry mismatch.
- **`idempotencyKey`** — the key is the dedup anchor, not part of the body being
  deduplicated.
- **Owner-injected identifiers** — ids the gateway folds in from the authenticated
  principal (e.g. `customerId` derived from `@CurrentUser().id`), which are a
  property of the session, not of the submitted body.

Excluding these keeps the fingerprint a pure function of *what the client asked to
do*, so a network-blip retry of the same intent — even under a fresh correlation
id — matches and replays. **Which fields constitute "the body" is the caller's
decision**: the fingerprint utility canonicalizes and hashes whatever object it is
handed; choosing that object (assembling the stable logical body) belongs to the
use case that owns the operation.

## Related documents

- [The idempotency-key store and its TTL](02-idempotency-key-store-and-ttl.md) —
  the `idempotency_key` table, its entity and repository, and the retention sweep.
- [Replay does not republish events](06-replay-does-not-republish-events.md) — how
  the replay short-circuit returns the stored response *before* the event
  publisher, so a retry emits no duplicate domain events.
- [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) — the decision
  record for the idempotency-key store, the rejected shared-store alternative, and
  the enforced optimistic-concurrency capability it ships alongside.
