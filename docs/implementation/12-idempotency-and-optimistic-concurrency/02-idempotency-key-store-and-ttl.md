# The idempotency-key store and its TTL

The retail write surface moves money and stock: place an order, capture a payment, ship a
fulfillment, issue a refund. Those calls reach the gateway over HTTP and reach the
microservices over an **at-least-once** message bus
([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)), and HTTP clients retry on a
timeout or a dropped connection. So the same logical write can arrive **twice**. Without a
dedup mechanism a retried "capture payment" double-charges and a retried "ship" double-ships.

Place Order already accepted an `Idempotency-Key` header — but only **logged** it, never
acted on it ([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)). This document
describes the persistence substrate that finally backs that header: the `idempotency_key`
table, its entity and direct-implement repository, and the `IDEMPOTENCY_STORE` application
port. The store boots and migrates here; the use cases that read and write it (the replay
short-circuit on each mutating operation) wire in as that capability lands.

Related decisions:
[ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) (this capability — the
store shape it mandates and the replay semantics) and
[ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md) (TypeORM + MySQL,
hand-authored migrations, `synchronize` off).

## Why a store at all

Request-level idempotency means: **a client attaches a unique key to a write, and the server
guarantees the operation runs at most once for that key.** The first call executes and the
server *remembers* its response; any later call with the same key returns that remembered
response without re-executing. The memory is the `idempotency_key` table — a small
stored-response cache keyed by the client's `Idempotency-Key`, scoped per operation.

This is the missing half of the system's duplicate-suppression story. The bus side already
has the **idempotent-consumer** pattern (the event store's `domain_event` composite UNIQUE
absorbs a redelivered event — [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)).
The store is the **request side**: it stops a duplicated *inbound* write before it executes,
rather than de-duplicating an *outbound* event after the fact.

## Why one table, retail-only

There is exactly **one** idempotency store, owned by the retail microservice, living in the
shared `retail_db`. It is deliberately **not** one-table-per-service.

The retail and inventory services share `retail_db`, and **inventory writes already have
natural-key idempotency**, so a second inventory-side table would be dead code:

- Reserve is idempotent-by-absolute-quantity on its `(cart_id, variant_id, stock_location_id)`
  UNIQUE triple.
- Commit-sale and Restock are idempotency-first on `fulfillmentId` / `returnRequestId` via the
  movement ledger
  ([ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)).

The genuine request-level dedup need is the retail HTTP write surface — place / capture /
ship / refund — so the table is retail-owned and lives next to those use cases in the
`orders/` module. A shared cross-service table was rejected because it reintroduces exactly
the cross-context shared-table coupling the bounded contexts avoid
([ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md);
[ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)).

## Table shape

| column | type | notes |
|---|---|---|
| `scope` | `VARCHAR(64)` | part of the composite PK — the operation namespace (`place-order`, `capture-payment`, `ship-fulfillment`, `issue-refund`). |
| `key` | `VARCHAR(64)` | part of the composite PK — the client `Idempotency-Key`. A MySQL reserved word, so it is backticked in the DDL and in generated SQL. |
| `request_fingerprint` | `CHAR(64)` | SHA-256 hex of the canonicalized request body. A replay must match it; a mismatch is a key-reuse error. |
| `response_status` | `INT` | the HTTP-equivalent status of the stored response. |
| `response_body` | `JSON` | the cached response payload, returned verbatim on a replay. |
| `created_at` | `TIMESTAMP` | row creation instant (`DEFAULT CURRENT_TIMESTAMP`). |
| `expires_at` | `TIMESTAMP` | `created_at + IDEMPOTENCY_KEY_TTL_HOURS`; the purge sweep deletes rows past this. |

**The composite primary key is `(scope, key)`.** `scope` namespaces the client key by
operation, so the same `Idempotency-Key` cannot collide across two unrelated writes (a client
that reuses `"abc"` for both a place and a capture gets two independent rows). The composite
PK is also the **concurrent-double-submit dedup anchor**: if two identical requests race, the
second INSERT loses on the primary key and is handled as a replay — the same load-existing-
then-return shape the notification-delivery dedupe uses
([ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md)). `key` is
**not** a standalone primary key.

**The entity does not extend `BaseEntity`.** A stored-response row is immutable: it is written
once and never updated. So it carries **no** surrogate auto-increment id, **no** `version`, and
**no** `updated_at` / `deleted_at` — those columns are simply absent. Only `created_at` and
`expires_at` exist. This is the append-only `domain_event` precedent
([ADR-034](../../adr/034-isolated-eventstore-database.md)), stronger than `stock_movement`'s
"inert by construction" stance because the mutation columns do not exist at all. The composite
PK is declared with two `@PrimaryColumn`s — the caller-assigned-PK idiom `Reservation` and
`Cart` already use to declare their own PK rather than inherit `BaseEntity`'s numeric id.

**`expires_at` is indexed** because it is the only column the purge sweep scans (a range
delete of everything older than now); a plain secondary index keeps that sweep off a full
table scan.

### The port and the repository

The application layer depends on `IIdempotencyStorePort` (symbol `IDEMPOTENCY_STORE`),
domain-typed only — no TypeORM type leaks past the adapter
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)):

- `find(scope, key): Promise<IIdempotencyRecord | null>` — load a prior record, or `null`. It
  does **not** filter by expiry: the scheduled purge is the sole authority that removes expired
  rows, so a not-yet-swept past-`expires_at` row is still returned (and served as a harmless
  idempotent replay). This keeps the read path query-simple and concentrates all TTL logic in
  one place.
- `save(record, scope?): Promise<void>` — insert the record, computing `expires_at` from the
  injected `IDEMPOTENCY_KEY_TTL_HOURS`. A duplicate-PK collision — the concurrent first-writer
  race — is swallowed as a **no-op** (it never throws), the defined outcome that lets the
  caller fall back to `find` and serve the race-winner's stored response. The optional
  transaction scope lets a use case persist the record **in the same transaction** as its
  write when an operation wants the record and the side effect to commit atomically.

The repository implements the port **directly** — deliberately *not* via
`BaseTypeormRepository`, whose public `save` / `softDelete` would contradict the append-only
record (the `DomainEventTypeormRepository` precedent). Its only mutating verb is `save`, which
uses `insert` (never `save`-with-id semantics), so there is no UPDATE or DELETE expression at
the persistence layer. The retention horizon reaches it through DI (a
`ConfigService`-backed value-provider token), never `process.env` inside the application
layer.

## Replay vs reuse-with-a-different-body

The store records a fingerprint of the request body so the wiring can distinguish a genuine
retry from a key collision. The semantics the mutating use cases enforce against this store:

- **Same key + same fingerprint → cached response.** The stored response is returned and the
  operation does **not** re-execute (and, crucially, emits no duplicate domain events). This is
  the safe retry path.
- **Same key + different fingerprint → `422`.** The client reused one key for two different
  bodies — a client bug surfaced loudly rather than silently honored with the wrong cached
  response.
- **Missing key on an operation that requires one → `400`.** A required-idempotency write
  refuses to run un-keyed.

The body fingerprint is a **canonical JSON + SHA-256** digest: the body is serialized with
recursively sorted object keys, so field order never changes the digest, and the hex digest is
stored in `request_fingerprint`. The canonicalization-and-hash utility is a focused helper that
lands alongside the use-case wiring.

## TTL

A stored-response row is not kept forever. `expires_at` is stamped at insert time as
`created_at + IDEMPOTENCY_KEY_TTL_HOURS`, and a row is purge-eligible once that horizon has
passed. The retention window is the `IDEMPOTENCY_KEY_TTL_HOURS` environment variable
(Joi-validated `integer().min(1)`, **default 24**), and it reaches the store only through DI.
Expired rows are deleted by **a scheduled purge (see below)** — reads never delete, so the TTL
is enforced in exactly one place.

## The scheduled purge

Removing expired rows is a background concern, kept off the read and write hot paths. A
scheduled sweep — the notification retry-sweeper precedent, built on `@nestjs/schedule` —
periodically deletes every `idempotency_key` row whose `expires_at` is in the past, using the
`expires_at` index.

**Why a sweep, and why `find` never deletes.** The store is *live-ephemeral*: a row matters
only until its retention horizon, then it is dead weight. Concentrating every deletion in one
background sweep keeps the two hot paths (`find` on every idempotent request, `save` on every
first execution) free of any expiry branch — `find` returns a straggler expired row and it is
served as a harmless replay (the operation already ran once; replaying its stored response
changes nothing), and the sweep reclaims that row shortly after. This is a deliberate
single-writer-of-deletes design: TTL logic lives in exactly one place, so it cannot drift
between the read path and the delete path.

**The three moving parts.**

- **The port method** — `IIdempotencyStorePort.deleteExpired(now: Date): Promise<number>`.
  It returns the number of rows removed. `now` is an **explicit parameter**, not a wall-clock
  read inside the adapter: the scheduler passes the current instant, and a test passes a
  future instant to force a deterministic deletion without touching the system clock (the
  seam the concurrency e2e leans on — "leave a row, advance simulated time, observe
  deletion"). The adapter issues a single bounded `DELETE FROM idempotency_key WHERE
  expires_at < now` scanning the `expires_at` index. Because it can only ever touch rows
  whose horizon has already elapsed, it is safe to run concurrently with live inserts — an
  in-flight, not-yet-expired record is never in range. This is the one DELETE the otherwise
  append-only, insert-only repository issues; a stored-response row is still never updated in
  place.

- **The application use case** — `PurgeExpiredIdempotencyKeysUseCase.execute(now = new Date())`
  calls `deleteExpired(now)` and logs the outcome (`info` when it removed rows, `debug` when
  the sweep found nothing). It holds no schedule of its own, so it is trivially unit-testable
  against an in-memory store double.

- **The infrastructure scheduler** — `IdempotencyPurgeScheduler` carries the
  `@Cron(CronExpression.EVERY_10_MINUTES)` decorator (discovered by `ScheduleModule.forRoot()`,
  wired in `orders.module.ts`) and invokes the use case, guarding the tick so a thrown sweep
  logs and lets the next tick retry rather than crashing the scheduler loop. The schedule
  decorator stays in `infrastructure/`, never in the use case — the notification
  `DeliveryRetryScheduler` precedent ([ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md) /
  [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)).

**Cadence rationale.** The retention window (`IDEMPOTENCY_KEY_TTL_HOURS`, default 24h) is what
actually bounds a row's lifetime; the ten-minute interval only decides how *promptly* an
already-expired row is reclaimed. A coarse cadence keeps the table bounded without a tight
delete loop, and — because `find` treats a straggler as a harmless replay — a row lingering a
few minutes past its horizon is never a correctness problem, only a few unused bytes.

The manual `.http` walkthroughs that demonstrate the replay / `422` / `If-Match` surface this
store backs are documented in
[07-http-files-updated-idempotency-blocks.md](07-http-files-updated-idempotency-blocks.md).
