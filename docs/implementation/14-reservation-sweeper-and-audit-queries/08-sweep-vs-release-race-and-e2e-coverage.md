# The sweep-vs-release race, and what the end-to-end suites pin down

Two writers can reach the same stock reservation at the same instant. A shopper removes the cart
line that holds it; an operator (or an unattended timer) sweeps it away because its TTL has
lapsed. Both paths do the same thing to the books — return the held units to `available` by
decrementing `stock_level.quantity_reserved`, and append one negative `release` row to the
`stock_movement` ledger. Exactly one of them may.

Nothing locks the candidate set. This note explains what settles the race instead, why the loser
is not an error, and what each of the six end-to-end suites this capability added would catch if
it regressed.

## 1. The race, drawn out

Both writers follow the same shape:

1. read the `reservation` row,
2. read its `stock_level`, remembering the row's optimistic `version`,
3. subtract the held quantity from `quantity_reserved`,
4. flip the reservation to a terminal status (`released` for a Remove Line, `expired` for a sweep),
5. `UPDATE stock_level … WHERE id = ? AND version = ?`,
6. save the reservation and append the ledger row,
7. commit.

Steps 1–7 run inside one transaction each. The interesting interleavings:

| | Remove Line | Sweep | Outcome |
| --- | --- | --- | --- |
| **A** | not yet started | scans, re-reads `active`, commits | The hold is `expired`. Remove Line's release then resolves **no active hold for this cart and variant** and returns an idempotent no-op. One decrement. |
| **B** | reads `active`, commits first | scans while the row is still `active`, re-reads it inside its transaction, sees `released` | The sweep **skips** the row and reports `expired: 0, skipped: 1`. One decrement. |
| **C** | reads `active` | reads `active` — both hold a stale `version` | Whichever `UPDATE` reaches the `stock_level` row second matches **zero rows**, because the winner already bumped the version. It raises `StockWriteConflictError`, its transaction rolls back, and `runWithStockWriteRetry` re-opens a fresh one — where the re-read now sees the winner's terminal status, and case A or B applies. One decrement. |

Two mechanisms, both already in the codebase before this capability existed, do the work:

- **The in-transaction `status = 'active'` precondition.** Neither writer trusts the row it read
  before opening the transaction. `SweepExpiredReservationsUseCase` re-reads each candidate by id
  under the transaction scope and skips a row that is no longer `active` (or whose `expiresAt` a
  concurrent `refresh` pushed past this invocation's `now`). `ReleaseReservationUseCase` does the
  same, and the domain re-asserts it once more: `Reservation.expire()` and `Reservation.release()`
  both throw `RESERVATION_INVALID_STATE` on a non-`active` source status. The candidate scan is
  **advisory**, never authoritative.

- **The version-checked compare-and-swap on `StockLevel`.** `persistStockLevelChange(level,
  expectedVersion, scope)` is an `UPDATE … WHERE version = expectedVersion`. A lost write matches
  zero rows and becomes a retry against a fresh snapshot, not a silent overwrite (ADR-036). The
  whole chunk retries as a unit.

The invariant they buy: **`quantity_reserved` is decremented exactly once per hold**, and the
append-only ledger carries exactly one `release` row for it. `concurrent-sweep-release.e2e-spec.ts`
is the standing proof.

## 2. Why no lock

The obvious alternative is `SELECT … FOR UPDATE` over the candidate set — take a row lock on every
stale hold, and on the `stock_level` rows behind them, for the duration of the sweep transaction.

It would work, and it would cost the wrong thing. The sweep is a **background batch** that walks
whatever accumulated since the last tick; the checkout path is **latency-sensitive and
interactive**. Locking the candidate set means every Add To Cart, Change Quantity, Remove Line and
Place Order touching a locked variant blocks behind a batch job that has no deadline. The blast
radius is not the stale hold — those belong to abandoned carts, nobody is waiting on them — it is
every *live* shopper on the same `(variantId, stockLocationId)` level. A sweep that runs long, or
that widens its batch after a backlog, degrades checkout precisely when the system is already busy.

The optimistic token already exists on `StockLevel` and every write path already honours it. Under
this race the contention is rare (a shopper must remove a line in the same handful of milliseconds
the sweep touches it) and a lost compare-and-swap costs one re-read, bounded by
`OCC_RETRY_ATTEMPTS`. Pessimism buys nothing the optimism does not already deliver, and charges the
checkout path for it. ADR-038 records this as a design commitment rather than an omission.

The bounded transaction is the same argument at a smaller scale: `RESERVATION_SWEEP_TRANSACTION_SIZE`
caps how many holds one transaction settles, which caps how long it holds the row locks its
`UPDATE`s do take.

## 3. Why the loser is not an error

Neither caller learns it lost, and neither should.

**A sweep that skips** answers `200 { scanned: 1, expired: 0, skipped: 1 }`. The counters are the
whole report: `scanned = expired + skipped` always holds, and a skipped candidate is by definition
one a concurrent writer had already settled or refreshed. Nothing went wrong — the hold was
reclaimed, just not by this invocation. (If the release committed *before* the candidate scan ran,
the sweep reports `scanned: 0`: the row was never a candidate, because the scan filters on
`status = 'active'`.)

**A Remove Line that loses** answers `200` with the line gone. Its release leg is best-effort by
construction: `RemoveFromCartUseCase` commits the cart write first, then calls the inventory release
inside a `try`/`warn`/swallow. That ordering is not about this race — it is because the cart write is
the primary outcome and an over-held unit is always reclaimable (by a later sweep, or by the manual
release endpoint). The race just happens to be one more reason the swallow is right: the hold the
release could not find had already been returned to `available` by the writer that beat it.

Surfacing either as a `409` would be actively wrong. The caller's intent was carried out. A `409`
would invite a retry that has nothing left to do.

## 4. The test-only escape hatch

A hold is stale because wall-clock time passed its `expires_at`. There is deliberately **no
production API that expires a hold on demand**: such an endpoint would hand an operator a way to
yank stock out from under a live checkout, and `SweepExpiredReservationsUseCase` reads `expires_at`
— it does not take one.

That leaves a suite two options: wait out `RESERVATION_TTL_MINUTES` (fifteen minutes, per hold), or
reach past the domain and age the row. The suites do the second, through exactly one method:

```ts
// test/data-source/reservation-sweep.e2e-spec.data-source.ts
public async ageReservation(id: string, expiresAt: Date): Promise<void> {
  await this.query(`UPDATE reservation SET expires_at = ? WHERE id = ?;`, [expiresAt, id]);
}
```

One column, one row, by primary key. Nothing else in the system writes `expires_at` backwards.

**The seeding connection must be pinned to `timezone: 'Z'`.** `reservation.expires_at` is a MySQL
`TIMESTAMP`, and `DatabaseModule.forRoot` pins `mysql2` to UTC so the application's `Date` binds and
reads back unshifted. A data source left at the driver default serialises its `Date` in the Node
host's local zone; the application then reads that instant as UTC, and the horizon moves by the
host's offset. Depending on the sign, the sweep either silently misses the row the suite just aged
or reclaims a hold that is still live. The failure is a timezone bug wearing a concurrency bug's
clothes, so all three sweeper suites open their data source with `timezone: 'Z'` — the
`IdempotencyE2ESpecDataSource` precedent.

## 5. What each suite pins down

| File | The one thing it catches |
| --- | --- |
| [`test/reservation-sweeper.e2e-spec.ts`](../../../test/reservation-sweeper.e2e-spec.ts) | The operator sweep stops reclaiming a hold end to end — or reclaims it without returning `quantity_reserved`, without the `release` ledger row, without invalidating the cache, or without emitting `inventory.stock.released` into the event store. Also: the second sweep stops being a no-op. |
| [`test/reservation-sweeper-cron.e2e-spec.ts`](../../../test/reservation-sweeper-cron.e2e-spec.ts) | The timer stops firing, stops honouring its configured cadence, starts writing an `actor_id` on an unattended tick, or leaks its `setInterval` past `onModuleDestroy`. |
| [`test/concurrent-sweep-release.e2e-spec.ts`](../../../test/concurrent-sweep-release.e2e-spec.ts) | `quantity_reserved` double-decremented, two `release` rows for one hold, a hold left `active` after both writers ran, a loser surfaced as a `4xx`, or an exhausted optimistic-retry budget. |
| [`test/audit-event-query.e2e-spec.ts`](../../../test/audit-event-query.e2e-spec.ts) | `GET /api/audit/events` stops returning a request's whole cross-service chain, stops reading newest-first, loses the `pageSize` ceiling, stops rejecting a transposed window, or stops gating on `audit:read`. |
| [`test/audit-entry-query.e2e-spec.ts`](../../../test/audit-entry-query.e2e-spec.ts) | `GET /api/audit/entries` stops finding a staff action by its event-name `action`, mis-attributes the actor, starts leaking PII into a `before`/`after` snapshot, or loses its default page window. |
| [`test/audit-trace-correlation.e2e-spec.ts`](../../../test/audit-trace-correlation.e2e-spec.ts) | `GET /api/audit/trace/:correlationId` stops reading forward, merges the two logs, returns rows belonging to another id, or starts answering an unknown id with a `404` instead of an empty trace. |

Three cross-cutting facts the suites encode, each of which cost a debugging cycle to learn:

- **The sweeper suites override `RESERVATION_SWEEP_INTERVAL_SECONDS` through a dynamic
  `import()`.** `ConfigModule.forRoot(...)` validates and snapshots the environment the moment the
  service's `app.module.ts` is imported, and `ConfigService.get` reads that snapshot **ahead of**
  `process.env`. A static import is hoisted above every statement in the file, so a `beforeAll`
  assignment lands too late. The cron suite drops the cadence to two seconds; the manual and race
  suites push it an hour out, so the service's own timer cannot settle the hold their explicit
  trigger is meant to settle.

- **The manual and race suites drain once before they count.** The reclaim is global: it acts on
  every `active` hold whose `expires_at` has passed, not only the suite's own. One drain sweep
  during setup makes `expired: 1` an assertion rather than a hope.

- **A suite that calls `/api/audit/*` must boot the event store's hybrid shape** — `create` → two
  `connectMicroservice` → `init()` → `startAllMicroservices()`, never `listen()`. Booting only the
  firehose queue does not make the audit routes *fail*; it makes them **hang**. `event_store_query_queue`
  is durable, so the broker accepts an RPC nobody consumes and the gateway waits for a reply forever.

The race suite additionally binds the gateway's HTTP server once, with `listen(0)`, instead of the
usual `init()`. When `server.address()` is null, `supertest` binds an ephemeral port itself — and
the `Test` that bound it closes the listener the moment *its own* request finishes. A suite whose
two calls finish at the same instant never notices; one that deliberately staggers them watches the
earlier call tear the socket out from under the later one, and the race surfaces as `ECONNRESET`
rather than as an outcome.

## 6. Polling, not sleeping

**The cron suite polls.** It ages a hold, then reads `reservation.status` every 200 ms until the
row leaves `active`, up to a bounded deadline. The alternative — `sleep(3000)` and assert once —
encodes an assumption about how promptly a loaded CI box gets round to a timer callback. That
assumption is false often enough to matter and silently true the rest of the time, which is the
worst combination: the suite fails for a reason unrelated to the code it tests. A poll encodes only
the outcome, and its timeout is the only number that has to be right.

The same reasoning covers every assertion that crosses the message bus. Ingestion into
`ris_eventstore` is `publish → broker → consume → insert`; the audit suites poll the query API
itself until the expected rows appear, so the read path is part of the assertion rather than a
thing the suite waits out.

**The concurrency suite loops.** A race that passes once has proved nothing about the interleaving
it did not take. But `Promise.all([removeLine(), sweep()])` alone is a weak loop: the two callers
reach the same reservation row over asymmetric paths — the sweep goes straight to `inventory_queue`,
while Remove Line commits the cart in `retail_db` and only then releases over RPC — so fired in the
same tick the sweep wins *every* time, and the loser-is-the-sweep branch never runs. The suite
therefore staggers the sweep's start across a growing delay, walking the interleaving window: at
~0 ms the sweep wins, at ~20 ms the release commits while the sweep has already scanned (the
`skipped: 1` case), past ~40 ms the release settles before the scan runs at all (`scanned: 0`). The
boundaries are machine-dependent, so the suite asserts what must hold in **every** regime and
classifies each race by the terminal status it reads back — never by the delay it used. A final,
delay-free test then pins the loser-is-the-sweep branch deterministically, by awaiting the release
before it sweeps at all.

## 7. Why the ingest suites still read raw SQL

`GET /api/audit/events` and `GET /api/audit/entries` can now answer the questions that
`test/event-store-firehose.e2e-spec.ts`, `test/event-store-audit-log.e2e-spec.ts`,
`test/event-store-idempotency.e2e-spec.ts`, `test/idempotency-place-order.e2e-spec.ts` and
`test/idempotency-refund.e2e-spec.ts` ask by SQL. They still read the tables, on purpose.

Those five suites prove **ingestion**: that the firehose captured a routing key, that the composite
UNIQUE on `domain_event` swallowed a duplicate, that a replayed Place Order emitted nothing the
second time. Routing an ingest assertion through the read path couples the two: a bug in a query
filter would mask a bug in the ingest, and a bug in the ingest would present as a bug in the query.
The suites that prove the read path (`audit-event-query`, `audit-entry-query`,
`audit-trace-correlation`) go through the API precisely because the API is what they are testing.

There is a practical dividend too. An ingest suite that reads its own table needs only the firehose
transport; one that reads through the gateway would have to boot the gateway, the query transport,
and a staff login, for an assertion that has nothing to do with any of them.

## Cross-links

- [`01-reservation-sweeper-design.md`](01-reservation-sweeper-design.md) — the use case, its
  bounded batches, and why the concurrency guard is a re-read rather than a lock.
- [`02-sweeper-cron-and-emit-granularity.md`](02-sweeper-cron-and-emit-granularity.md) — the
  imperative `SchedulerRegistry` interval, its teardown, and the per-hold emission granularity.
- [`03-manual-sweep-admin-endpoint.md`](03-manual-sweep-admin-endpoint.md) — the operator trigger
  and the `actorId` that distinguishes it from a tick.
- [`06-audit-proxy-endpoints-and-pagination.md`](06-audit-proxy-endpoints-and-pagination.md) — the
  three `/api/audit/*` routes, their page window, and where the ceiling lives.
- [ADR-038](../../adr/038-reservation-ttl-sweep-and-bounded-batches.md) — the sweep's decision
  record, including the no-lock commitment.
- [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) — the bounded optimistic
  write protocol whose compare-and-swap converts a lost write into a retry.
- [ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) — the
  `Reservation` aggregate and the *audit, not balance* `stock_movement` ledger.
