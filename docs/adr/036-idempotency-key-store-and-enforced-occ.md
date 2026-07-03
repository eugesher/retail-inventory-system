# ADR-036: Idempotency-key store and enforced optimistic concurrency

- **Date**: 2026-06-29
- **Status**: Accepted

---

## Context

As the checkout chain matured (cart → order → payment → fulfillment → returns/refunds),
two reliability gaps remained un-closed across the operational services:

1. **No request-level idempotency.** The message bus is **at-least-once**
   ([ADR-020](020-rabbitmq-as-inter-service-bus.md)) and HTTP clients retry on a timeout
   or a dropped connection. A money-moving or stock-moving write that arrives twice —
   place order, capture payment, issue refund, receive stock — double-charges or
   double-ships unless the write is deduplicated. Place Order already **accepts and logs**
   an `Idempotency-Key` header but does not act on it ([ADR-028](028-cart-order-payment-and-address-chain.md)).

2. **Optimistic concurrency is enforced in inventory but not in the operational
   aggregates.** Inventory's `StockLevel` / `Reservation` writes are version-checked
   compare-and-swaps retried by a bounded protocol
   ([ADR-027](027-stocklevel-running-totals-and-stocklocation.md),
   [ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md)). `Cart`,
   `Order`, `Fulfillment`, and `ReturnRequest` all **ship a `version` column** but do not
   yet consume it — two concurrent writers to the same aggregate (two staff editing one
   order, a ship racing a cancel, two tabs on one cart) can lose an update. The inventory
   budget is also a hardcoded `MAX_WRITE_ATTEMPTS = 5` rather than an operational knob.

This ADR decides the whole hardening capability — the idempotency-key store, the enforced
optimistic concurrency on the operational aggregates, and the `409 VERSION_MISMATCH`
translation — in **one record**, following the precedent that one ADR fixes a capability
whose code lands across several changes ([ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) /
[ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) /
[ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md)). The configuration
substrate and the inventory budget change land first; the store, the operational-aggregate
OCC, and the filters land in follow-up changes.

## Decision

### 1. A single `idempotency_key` table in `retail_db`, owned by the retail microservice

There is **one** idempotency store, not one per service. The retail and inventory services
share `retail_db`, and **inventory writes already have natural-key idempotency** — Reserve
is idempotent-by-absolute-quantity on the `(cart_id, variant_id, stock_location_id)` UNIQUE
triple, and Commit-sale / Restock are idempotency-first on `fulfillmentId` / `returnRequestId`
via the movement ledger ([ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) /
[ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md)). An inventory idempotency
table would therefore be dead code. The genuine request-level dedup need is the **retail HTTP
write surface** (place order, capture, refund), so the table is retail-owned.

Schema:

- **Composite primary key `(scope, key)`.** `scope` namespaces the client key by operation
  (e.g. `order.place`, `payment.capture`, `refund.issue`) so the same key cannot collide
  across two unrelated operations; `key` is the client-supplied `Idempotency-Key`.
- **It does NOT extend `BaseEntity`.** A stored-response record is immutable — there is no
  auto-increment surrogate id, no `updated_at` / `deleted_at`, no `version`. Only
  `created_at` and `expires_at` exist (the append-only `stock_movement` / `domain_event`
  precedent — [ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) /
  [ADR-034](034-isolated-eventstore-database.md)).
- Columns: `scope`, `key`, `request_fingerprint` (`CHAR(64)`, the SHA-256 hex),
  `response_status` (the captured HTTP status), `response_body` (JSON), `created_at`,
  `expires_at`.

Body fingerprint — **canonical JSON + SHA-256**: the request body is serialized with
recursively sorted object keys (so field order never changes the digest) and hashed; the
hex digest is stored alongside the captured response.

Semantics:

- **First call** for a `(scope, key)`: execute the operation, persist
  `(scope, key, fingerprint, status, body, now, now + IDEMPOTENCY_KEY_TTL_HOURS)`, return
  the response.
- **Replay** (same `scope` + `key` + fingerprint): **short-circuit** — return the *stored*
  response with `200` and the header `Idempotent-Replay: true`, **without re-executing**.
  The replay returns **before the event publisher**, so a replay emits **no** duplicate
  domain events.
- **Same key, different fingerprint** → `422` (`IDEMPOTENCY_KEY_REUSED`): the client reused
  a key for a different body, a client bug surfaced rather than silently honored.
- **Missing key on an operation that requires one** → `400` (`IDEMPOTENCY_KEY_REQUIRED`).
- **Concurrent double-submit**: place / capture / ship run `find → work → save`. That is safe
  under concurrency because each has a *second* serializing guard — the cart-conversion CAS
  (place), the payment-state check + order OCC (capture), the ship `SELECT … FOR UPDATE` — so
  a redundant concurrent run is at worst a benign idempotent gateway op, and the composite-PK
  collision on `save` dedups the *stored response*. **Refund is the exception**: it has no
  such second guard and the gateway refund is **not** naturally idempotent, so a plain
  `find → refund → save` would let two truly concurrent same-key submits BOTH refund before
  either records the key. Refund therefore uses **reserve-first**: an atomic INSERT of a
  *pending* row (the `response_status` / `response_body` columns are **nullable** for this)
  claims `(scope, key)` BEFORE the gateway call. A concurrent duplicate loses that INSERT and
  is turned away with `409 ORDER_IDEMPOTENCY_KEY_IN_PROGRESS` before it can refund a second
  time; the winner runs the refund, then `finalize`s the row with the response (a completed,
  replayable record), or `release`s the pending row on failure so a legitimate retry can
  re-run (the natural already-issued guard remains the backstop for the rare
  gateway-succeeded-then-crashed window). This is the notification-delivery
  persist-**before**-the-side-effect dedupe precedent
  ([ADR-033](033-notification-templates-deliveries-and-render-dispatch.md)); the `find`/`save`
  flow above is the retry-only variant the other three writes can afford.

**TTL purge.** A record is purge-eligible once `created_at + IDEMPOTENCY_KEY_TTL_HOURS` has
passed. A scheduled sweep (the notification retry-sweeper precedent, `@nestjs/schedule`)
deletes expired rows; the retention default is 24 hours.

### 2. Enforced optimistic concurrency on the operational aggregates

`Cart`, `Order`, `Fulfillment`, and `ReturnRequest` writes become **version-checked**: read
the aggregate (capturing its `version`), mutate in memory, then persist with
`UPDATE … SET version = version + 1 WHERE id = ? AND version = ?`. A zero-rows-affected
result means a concurrent writer advanced the row first — an optimistic conflict. The
conflict is retried under a **fresh transaction** per attempt, up to **`OCC_RETRY_ATTEMPTS`**
attempts; on exhaustion the write surfaces a **`409 VERSION_MISMATCH`** carrying the current
version so the caller can refetch-and-retry. This is the same bounded-retry shape inventory
already uses; the operational aggregates simply start consuming the `version` columns they
already ship.

Inventory's `StockLevel` / `Reservation` OCC is **already enforced** — this ADR does **not**
add OCC there. Its only inventory change is making the retry budget **configurable**
(`OCC_RETRY_ATTEMPTS` replaces the hardcoded `MAX_WRITE_ATTEMPTS = 5`) and **raising the
per-attempt retry trace to `info`** so the concurrency tests can assert it.

An optional **`If-Match: <version>`** precondition is honored on cart line writes: a client
that holds a known version may pass it, and the write rejects with `409` when the stored
version has moved (HTTP precondition-failed semantics). Absent the header, the retry loop
makes last-writer-within-budget win.

### 3. The `409 VERSION_MISMATCH` translation (two layers)

- **Microservice side.** Each module's RPC exception filter maps its OCC-exhaustion conflict
  to `409 { code: 'VERSION_MISMATCH', details: { currentVersion } }`. The gateway's existing
  `throwRpcError` forwards the typed `code` + object-valued `details` verbatim
  ([ADR-028](028-cart-order-payment-and-address-chain.md)), so a client branches on the
  stable `code` and reads `details.currentVersion`. Inventory keeps its existing
  `STOCK_WRITE_CONFLICT` code (already a `409`); `VERSION_MISMATCH` is the operational-
  aggregate name for the same class of optimistic conflict.
- **Gateway side.** A gateway-global filter maps TypeORM's `OptimisticLockVersionMismatchError`
  → `409` for any gateway-local OCC (e.g. the `auth` aggregates), so a lost gateway-side CAS
  never leaks a raw `500`.

### The configurable budget (`OCC_RETRY_ATTEMPTS`) and retention (`IDEMPOTENCY_KEY_TTL_HOURS`)

Two new environment variables join the shared Joi schema, validated as `integer().min(1)`
and **defaulted** (so a missing var never fails boot, the `RESERVATION_TTL_MINUTES`
precedent):

- `IDEMPOTENCY_KEY_TTL_HOURS` — default **24**.
- `OCC_RETRY_ATTEMPTS` — default **5**.

**Why the budget default is 5, not 3.** The live inventory protocol used a hardcoded `5`,
and the high-contention concurrency tests (e.g. 50 concurrent `Receive +1` writes converging
to `seed + 50` with no lost updates) need enough attempts to converge under contention. A
budget of `3` risks flakiness under high fan-out; `5` keeps the suite reliably green while
still bounding a genuinely stuck write to a fast `409`. The budget reaches the application
layer **only through DI** — a `ConfigService`-backed value-provider token — never
`process.env` inside `application/` ([ADR-017](017-architecture-lint-via-eslint-boundaries.md)).
The hardcoded `MAX_WRITE_ATTEMPTS` constant is **deleted**; the inventory retry protocol's
dependency set carries an injected `maxAttempts`.

Post-commit cache invalidation is unchanged: `withInvalidation` still wraps the retried
transaction and the prefix delete runs after commit
([ADR-023](023-cache-invalidate-post-commit-by-type.md)).

## Alternatives Considered

- **A shared cross-service idempotency store** (one table every service reads and writes).
  Rejected: it reintroduces the cross-service shared-table coupling the bounded contexts
  deliberately avoid (each context owns its tables; cross-context reads go through reader
  ports — [ADR-017](017-architecture-lint-via-eslint-boundaries.md)). Inventory already has
  natural-key idempotency, so the only real consumer is the retail HTTP surface; one
  retail-owned table is sufficient and keeps ownership clean.
- **A distributed lock manager / Redlock** for write serialization. Rejected: optimistic
  concurrency on a `version` column already exists ([ADR-027](027-stocklevel-running-totals-and-stocklocation.md)
  shipped the column for exactly this) and is unit-testable with fakes. A lock manager adds
  an operational dependency, lock-lease and clock-skew failure modes, and contention for no
  benefit at this scale.
- **Pessimistic locking everywhere** (`SELECT … FOR UPDATE` on every aggregate write).
  Rejected as the default: it adds lock-contention and deadlock surface across the entire
  write path. The Fulfillment ship-vs-cancel path already takes a *targeted* row lock where a
  single-writer-per-transition guard is genuinely required
  ([ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md)); that stays. OCC is
  the default; a targeted pessimistic lock is the documented exception OCC complements.
- **A transactional outbox** to make request-level idempotency unnecessary. Rejected for this
  scope ([ADR-020](020-rabbitmq-as-inter-service-bus.md) /
  [ADR-035](035-event-store-firehose-topic-exchange.md)): the bus is at-least-once and
  publishes are best-effort post-commit. Request-level idempotency on the write surface plus
  the idempotent-consumer pattern (the `domain_event` composite UNIQUE) absorb duplicates
  without the outbox machinery.

## Consequences

- `IDEMPOTENCY_KEY_TTL_HOURS` and `OCC_RETRY_ATTEMPTS` join the shared Joi schema,
  `.env.example`, and the consuming `docker-compose` service blocks; both are defaulted, so
  no service fails boot without them.
- Inventory's retry budget is now `OCC_RETRY_ATTEMPTS`-driven (default 5) via a value-provider
  token; `MAX_WRITE_ATTEMPTS` no longer exists. The per-attempt OCC retry now logs at `info`
  carrying the attempt count, the row identity, and the `fromVersion` the compare-and-swap
  targeted (the winning `toVersion` is **not** read back — the conflict path stays
  deliberately query-free).
- The `idempotency_key` table, its append/load repository, the canonical-JSON + SHA-256
  fingerprint utility, the replay short-circuit on the retail write surface, and the TTL sweep
  land across follow-up changes.
- Version-checked enforcement on `Cart` / `Order` / `Fulfillment` / `ReturnRequest`, the
  per-module `VERSION_MISMATCH` mapping, and the gateway-global OCC filter land across
  follow-up changes. The concurrency suites (oversell, lost-update, idempotent-replay) lock
  the capability.
- No production data exists, so the `idempotency_key` table is a clean additive migration
  ([ADR-019](019-typeorm-and-mysql-for-persistence.md); `synchronize` stays off).

## References

- [ADR-027](027-stocklevel-running-totals-and-stocklocation.md) — the `version` column shipped
  on `stock_level` for exactly this optimistic guard; the precedent for shipping a version
  column before its consumer.
- [ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) — the bounded
  optimistic write protocol (`runWithStockWriteRetry`) this generalizes and makes
  budget-configurable; the natural-key inventory idempotency that makes a second store
  unnecessary.
- [ADR-023](023-cache-invalidate-post-commit-by-type.md) — `withInvalidation`; post-commit
  invalidation is preserved around the retried transaction.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — TypeORM + MySQL, hand-authored
  migrations, `synchronize` off.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — boundaries; configuration
  reaches the application layer through DI, never `process.env`.
- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — the at-least-once bus and best-effort
  post-commit publish that make request-level idempotency necessary.
- [ADR-028](028-cart-order-payment-and-address-chain.md) — the `Cart` / `Order` / `Payment`
  chain, its `version` columns, the `throwRpcError` typed-code forwarding, and the
  `Idempotency-Key` header already accepted on Place Order.
- [ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) — the targeted
  ship-vs-cancel row lock; the pessimistic-locking exception that OCC complements.
- [ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md) — the `ReturnRequest`
  version column and the natural refund idempotency.
