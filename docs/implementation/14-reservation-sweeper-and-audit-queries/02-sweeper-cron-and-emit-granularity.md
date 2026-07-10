# Driving the expired-hold sweep on a timer, and what it emits

The sibling note [`01-reservation-sweeper-design.md`](01-reservation-sweeper-design.md)
describes `SweepExpiredReservationsUseCase` — the scan, the two bounds, the race it settles
without a lock. This note describes the thing that *calls* it: a timer inside the inventory
microservice, ticking at a cadence an operator sets. It also settles a question the sweep's
design raises and the design note only points at: **how many events one sweep emits.**

The driver is
`apps/inventory-microservice/src/modules/stock/infrastructure/scheduling/reservation-sweep.scheduler.ts`.
The decision it implements is
[ADR-038](../../adr/038-reservation-ttl-sweep-and-bounded-batches.md).

## 1. What runs on a timer in this system

Three scheduled jobs, one per service that needs one. All three are `infrastructure/`
providers that wrap a use case; none of them contains business logic.

| Job | Cadence | Registered in | A missed tick costs |
| --- | --- | --- | --- |
| Notification delivery retry (`DeliveryRetryScheduler`) | `@Interval('notification-delivery-retry-sweep', 60_000)` — fixed 60 s | `apps/notification-microservice/src/modules/notifications/infrastructure/scheduling/delivery-retry.scheduler.ts` | A `failed` delivery waits one more minute for its next attempt. The backoff gate inside `RetryFailedDeliveriesUseCase`, not this interval, is what spaces an individual delivery's re-attempts, and `notification.delivery.retry` is the operator's immediate path. |
| Idempotency-key TTL purge (`IdempotencyPurgeScheduler`) | `@Cron(CronExpression.EVERY_10_MINUTES, { name: 'idempotency-key-purge-sweep' })` | `apps/retail-microservice/src/modules/orders/infrastructure/idempotency/idempotency-purge.scheduler.ts` | Rows past `created_at + IDEMPOTENCY_KEY_TTL_HOURS` linger in `idempotency_key`. Storage only — a stale row is never read, because the store filters on `expires_at`. |
| Reservation TTL sweep (`ReservationSweepScheduler`) | `RESERVATION_SWEEP_INTERVAL_SECONDS`, Joi default 60 s — **configured** | `apps/inventory-microservice/src/modules/stock/infrastructure/scheduling/reservation-sweep.scheduler.ts` | `available` understates reality: units held by a hold nobody will use stay unsellable until the next tick observes them. Oversell-safe (the system under-sells), but the "only 1 left!" signal is pessimistic. |

The first two hardcode their cadence in the decorator. The third does not, and that single
difference forces every other decision in this note.

## 2. Why this one reads its cadence from configuration

Two independent arguments, either of which alone would be enough.

**Deployment.** The sweep interval and `RESERVATION_TTL_MINUTES` are coupled: a hold's units
are unreclaimable from `expiresAt` until the sweep that observes it, so the tick should sit
well inside the TTL. A warehouse that runs a 15-minute TTL and a demo that runs a 1-minute
TTL do not want the same tick. Baking 60 seconds into the class would silently make the
short-TTL deployment reclaim a hold up to a full interval late — the exact window
[ADR-038](../../adr/038-reservation-ttl-sweep-and-bounded-batches.md) names as the cost of a
coarse cadence.

**Test.** An end-to-end check that a stranded hold is actually reclaimed has to wait for a
tick. At 60 seconds it cannot; at two seconds it can. A decorator constant cannot be lowered
by an environment variable, so a hardcoded cadence would leave the timer itself untestable —
provable only by reading the source.

`RESERVATION_SWEEP_INTERVAL_SECONDS` is Joi-validated (`integer().min(1).default(60)`) in
`libs/config/config-module.config.ts`, so a missing var never fails boot, and it appears in
`.env.example`, `.env.local`, and the inventory block of `docker-compose.yml`.

It reaches the scheduler as a `ConfigService`-backed **value-provider DI token**, declared
beside the sweep's other two knobs in
`application/ports/reservation-sweep.tokens.ts` and bound in `infrastructure/stock.module.ts`:

| Env var | Joi | Token | Injected by |
| --- | --- | --- | --- |
| `RESERVATION_SWEEP_BATCH_SIZE` | `integer().min(1).default(200)` | `RESERVATION_SWEEP_BATCH_SIZE` | the use case |
| `RESERVATION_SWEEP_TRANSACTION_SIZE` | `integer().min(1).default(25)` | `RESERVATION_SWEEP_TRANSACTION_SIZE` | the use case |
| `RESERVATION_SWEEP_INTERVAL_SECONDS` | `integer().min(1).default(60)` | `RESERVATION_SWEEP_INTERVAL_SECONDS` | the scheduler |

The interval's token lives beside the application ports even though only an infrastructure
class injects it. That is where the module's other configuration tokens live, so all three
knobs are greppable in one file — and it keeps the scheduler free of a `ConfigService`
import, matching how the use cases receive theirs
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)).

Note that the three knobs bound three different things and must not be collapsed. The batch
size caps the **work** per tick; the transaction size caps the **lock hold time**; the
interval decides only **how promptly** an already-expired hold is reclaimed.
`RESERVATION_TTL_MINUTES` is what bounds a hold's life. Raising the interval never makes a
hold live longer — it makes its reclaim later.

## 3. Why `@Interval` cannot express that

A decorator's arguments are evaluated when the class body is evaluated — at module load,
when the file is first `require`d. The DI container does not exist yet, so there is nothing
to ask for the resolved value:

```ts
// Impossible. `intervalMs` would have to be a module-level constant, and the injected
// `RESERVATION_SWEEP_INTERVAL_SECONDS` is not resolvable until the module is instantiated.
@Interval('reservation-ttl-sweep', intervalMs)
public async sweep(): Promise<void> {}
```

`@nestjs/schedule` provides `SchedulerRegistry` for exactly this. Register the timer
imperatively in `onModuleInit`, by which point the constructor has run and the injected
value is in hand:

```ts
public onModuleInit(): void {
  const intervalMs = this.intervalSeconds * 1000;
  const handle = setInterval(() => void this.sweep(), intervalMs);
  this.schedulerRegistry.addInterval(RESERVATION_SWEEP_INTERVAL_NAME, handle);
  this.logger.info({ intervalSeconds: this.intervalSeconds }, 'Reservation sweep scheduled');
}
```

`ScheduleModule.forRoot()` — wired into `stock.module.ts`, the inventory service's first —
is what makes `SchedulerRegistry` injectable. It is otherwise doing nothing here: there is
no decorated method for its explorer to discover.

The interval's registry key is an exported constant,
`RESERVATION_SWEEP_INTERVAL_NAME = 'reservation-ttl-sweep'`. Two callers need to agree on it:
`onModuleDestroy` below, and any test that resolves `SchedulerRegistry` to reach the live
timer.

## 4. Lifecycle: the interval must be deleted on destroy

A raw `setInterval` handle is invisible to Nest. Nobody clears it when the container closes,
and the timer outlives the objects it calls into. Two concrete costs follow, and the second
is the one that bites:

- The timer keeps firing into a torn-down container. `SweepExpiredReservationsUseCase` still
  holds references to repositories whose TypeORM connection has been closed, so every tick
  throws — into the `catch` block, which logs a `warn` against a logger nobody is reading.
- **A pending `setInterval` keeps the Node event loop alive.** In a Jest end-to-end run,
  where suites close and reopen Nest applications in one worker process, a leaked timer means
  the worker never exits. Jest reports the suite as passing and then hangs, or prints *"A
  worker process has failed to exit gracefully"* and force-exits — with the failure attributed
  to whichever suite happened to be last.

So the scheduler deletes what it registered:

```ts
public onModuleDestroy(): void {
  if (this.schedulerRegistry.doesExist('interval', RESERVATION_SWEEP_INTERVAL_NAME)) {
    this.schedulerRegistry.deleteInterval(RESERVATION_SWEEP_INTERVAL_NAME);
  }
}
```

`deleteInterval` calls `clearInterval` on the stored handle and drops it from the registry.
The `doesExist` guard is load-bearing, not defensive noise: `deleteInterval` resolves the
handle through `getInterval`, which **throws** on an unknown name. Without the guard, a
container that failed before `onModuleInit` would throw a second error on the way down and
mask the first.

**Is the explicit teardown redundant?** Not quite, and the reason is worth knowing. Handing
the handle to `SchedulerRegistry` does buy some cleanup by accident: today
`SchedulerOrchestrator.beforeApplicationShutdown()` calls `clearIntervals()`, which walks
`SchedulerRegistry.getIntervals()` — **every** interval in the registry, not only the ones its
own explorer mounted from `@Interval` decorators. That is an implementation detail of the
current `@nestjs/schedule`, not a documented contract, and it fires only when
`ScheduleModule.forRoot()` is in the graph *and* something calls `app.close()`.

The explicit hook makes the teardown ours. It runs first in Nest's close sequence
(`onModuleDestroy` → `beforeApplicationShutdown` → `onApplicationShutdown`), it survives a
future version of the library that narrows `clearIntervals()` to its own entries, and it holds
when the scheduler is constructed directly — as its unit spec does. Owning the handle's whole
lifetime is the point of registering it imperatively in the first place.

## 5. The guarded tick

The scheduler swallows. The use case does not. That split is deliberate and is stated in
[ADR-038](../../adr/038-reservation-ttl-sweep-and-bounded-batches.md)'s Consequences.

```ts
private async sweep(): Promise<void> {
  try {
    await this.sweeper.execute();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    this.logger.warn({ reason }, 'Reservation sweep failed');
  }
}
```

`SweepExpiredReservationsUseCase` runs its chunks under `runWithStockWriteRetry`; when the
`OCC_RETRY_ATTEMPTS` budget is exhausted under contention, it raises `STOCK_WRITE_CONFLICT`
and aborts the invocation. A use case that swallowed that would be lying to an operator who
invoked it directly — the write did not happen, and the caller must be told.

A *timer*, on the other hand, has nobody to tell. `void this.sweep()` discards the promise,
so a rejection would surface as an unhandled rejection, and under sustained contention as a
crash loop — one per tick, forever. Contention is transient by definition: the next tick
re-reads a fresh snapshot and, most likely, succeeds. Swallow and `warn`, exactly as
`DeliveryRetryScheduler` and `IdempotencyPurgeScheduler` do.

A sweep that outruns its interval would overlap itself, and `setInterval` does not care: it
fires on its cadence whether or not the previous callback has settled. That overlap is never
*harmful* — the sweep is re-entrant by construction, because every candidate row is re-read
under its transaction and a row another writer already expired falls into the
`status !== 'active'` skip. The same mechanism that makes two sweeper *processes* safe makes
two overlapping ticks safe.

Safe is not the same as useful. The loser of the race re-reads every row the winner already
expired, skips all of them, and — where the two chunks touch a shared `StockLevel` — burns its
whole `OCC_RETRY_ATTEMPTS` budget losing the compare-and-swap, reclaiming nothing for double
the database work. `RESERVATION_SWEEP_INTERVAL_SECONDS` has a Joi floor of `1`, so overlap is
reachable by configuration alone, not just by a pathological backlog. So `sweep()` holds a
private `sweeping` boolean and returns early — at `debug`, not `warn`, because a skipped tick
is a healthy system draining a backlog, not a fault. The flag is cleared in a `finally`: a
throw that wedged it on would silence the timer for the life of the process.

The guard is deliberately *not* a lock. It excludes a tick from a tick within one process; it
does nothing about a second replica, or about the `inventory.reservation.sweep` RPC firing
mid-tick. It does not need to. Those paths stay correct by the re-entrancy argument above —
which is exactly why this is an efficiency guard that may be removed without a correctness
review, and why the sweep must never grow one that a caller depends on.

## 6. Emission granularity: one event per reservation row

A sweep that expires forty holds spread over three stock levels emits **forty**
`inventory.stock.released` events and forty `inventory.stock-movement.recorded` events — not
three of each. This is a decision, not an oversight
([ADR-038](../../adr/038-reservation-ttl-sweep-and-bounded-batches.md) §6).

Coalescing per `(variantId, stockLocationId)` would have to sum the quantities and **null the
`cartId` and `reservationId` fields**, because a coalesced event has no single cart and no
single hold. Those two fields are the entire correlation value the event carries: they are
what connects an unattended reclaim back to the abandoned cart that caused it. The ledger
already records one row per hold, so a coalesced event would also be the only artefact in the
system that cannot be joined back to `stock_movement`.

There is also nobody to coalesce *for*. `inventory.stock.released` is a **reserved surface**:
no business consumer binds it. Its only subscriber is the event-store firehose
([ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)), which is happy to ingest
forty rows and would gain nothing from three. Fewer, coarser events would be an improvement
for a consumer that does not exist, purchased by destroying information for the one that does.

Finally, per-row emission makes the sweep's events **shape-identical** to the manual release
path's. `ReleaseReservationUseCase` emits one `inventory.stock.released` per hold, carrying
`cartId`, `reservationId`, and `reason`. The sweep emits the same event with
`reason: 'expired'`. A consumer that ever binds the routing key sees one event shape, not two.

**The consumer obligation, stated plainly:** any future consumer of
`inventory.stock.released` must tolerate **several events per stock level per sweep**, arriving
close together, each carrying a distinct `reservationId`. A consumer that assumes one event per
`(variantId, stockLocationId)` per unit of time will be wrong.

Both emissions are post-commit and best-effort
([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)): the counters are already durable
when they fire, so a broker failure is `warn`-logged and swallowed rather than raised.

## 7. Observable signals

Everything below is a Pino line from the inventory microservice.

| Level | Message | Fields | When |
| --- | --- | --- | --- |
| `info` | `Reservation sweep scheduled` | `intervalSeconds` | once, at boot. The only proof from outside the process that the timer is armed, and at what cadence. |
| `debug` | `Reservation sweep: nothing expired` | `correlationId`, `now` | the steady state — the scan found no candidates, and no transaction was opened. |
| `debug` | `Reservation sweep completed — every candidate was skipped` | `correlationId`, `scanned`, `expired`, `skipped`, `batches`, `durationMs` | candidates existed but another writer had already handled each one. |
| `info` | `Reservation sweep completed` | same | the sweep reclaimed at least one hold. Real churn, worth a line. |
| `warn` | `Reservation sweep failed` | `reason` | the tick threw — an exhausted retry budget, or a torn-down dependency. The next tick will try again. |

The empty sweep sits at `debug` on purpose. At the default cadence a healthy system produces
one of those every 60 seconds forever; at `info` it would drown the log and teach operators to
ignore it.

**Where the `correlationId` comes from.** The scheduler passes none. The use case mints one
per invocation with `randomUUID()`, because a background tick has no request scope: it did not
start with an HTTP request, and there is no trace to join. Every hold expired by one invocation
shares that id, and it will not appear in any customer's trace. The `cartId` and
`reservationId` on the event and on the ledger row are what connect the release back to the
cart that caused it.

The id is logged as an **inline field**, never through `PinoLogger.assign()`. That method only
works inside nestjs-pino's request scope and throws outside one — `PinoLogger: unable to assign
extra fields out of request scope`
([ADR-011](../../adr/011-notifier-port-and-adapters.md) §7). A scheduled tick is as far outside
a request scope as code gets.

## Cross-links

- [`01-reservation-sweeper-design.md`](01-reservation-sweeper-design.md) — the sweep itself:
  the scan, the two bounds, the lock-free race.
- [`08-sweep-vs-release-race-and-e2e-coverage.md`](08-sweep-vs-release-race-and-e2e-coverage.md)
  — the end-to-end suite that drives this timer, asserts `actor_id IS NULL` on a tick's ledger
  row, and proves the interval is unregistered when the container closes.
- [ADR-038](../../adr/038-reservation-ttl-sweep-and-bounded-batches.md) — the decision record
  for the whole capability, including §6 on per-row emission and the Consequences that split
  the `try`/`catch` between driver and use case.
- [ADR-011](../../adr/011-notifier-port-and-adapters.md) §7 — correlation goes on the log line,
  not via `PinoLogger.assign()`.
- [ADR-001](../../adr/001-structured-logging-with-pino.md) — structured logging with Pino, the
  substrate every line above is written on.
- [ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md) — post-commit, best-effort
  publishing: a broker failure never rolls back a committed counter.
- [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md) — why the cadence arrives
  as a DI token rather than a `ConfigService` read.
