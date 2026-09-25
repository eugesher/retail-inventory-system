# Testing

This file covers how the end-to-end harness under `test/` works: how a suite boots the services,
where configuration is read, how suites share one database, how they wait for asynchronous work, and
the helpers that read and write MySQL directly. The commands, the capability-to-suite map and the
"assert through public state" rule are in [`README.md` §9](../../README.md#testing). The seed data
the suites start from is in [§10](../../README.md#10-seed-data), and the seeded logins are in
[§1](../../README.md#seeded-logins).

## Running

- **Every spec file runs serially in one process.** `test:e2e:run` and `test:run` both pass `-i`
  (`package.json`). Jest orders the files by its own cache of earlier runs, so no suite may depend
  on another having run first.
- **The per-test and per-hook timeout is 120 s,** set with `jest.setTimeout` in
  `test/jest.setup.ts`. It cannot be `testTimeout` in `jest.e2e.config.js`: Jest 29 groups
  `testTimeout` with the global options, so under `yarn test:run` (`--projects`) a project
  config's value is dropped with only a validation warning, and every hook falls back to 5 s.
  `setupFiles` is a project option, so the setup file applies in both runs.
- **A request to a service the suite did not boot hangs until that timeout.** The queues are
  durable, so the broker accepts the RPC and nobody answers, and the gateway sets no RPC timeout
  ([`api-gateway.md`](api-gateway.md#failure-modes)).

## The setup file

`test/jest.setup.ts` runs in each spec file's sandbox before the file's own imports:

- It loads `.env.local` with `dotenv`, which does not override a variable that is already set. It
  then sets `NODE_ENV=test`, `DATABASE_LOGGING=false` and `HEALTH_PROBE_TIMEOUT_MS=400`, so the
  health suite's dead-service probe does not wait out the 2 s default.
- It installs the log capture ([`shared-libraries.md`](shared-libraries.md#the-e2e-log-capture))
  and exposes the captured records as `globalThis.__RIS_E2E_CAPTURED_LOGS__`. The records are raw
  objects, so a suite that matches on `msg` checks that it is a string first
  (`test/concurrent-sweep-release.e2e-spec.ts`, `logsMatching`).

## Configuration is read when an `AppModule` is imported

- **`ConfigModule.forRoot` runs inside each `AppModule`'s `@Module` decorator,** so it runs when the
  module file is loaded. It validates the environment then, and `ConfigService.get` answers from
  that validated copy before it looks at `process.env` (`@nestjs/config` 4.0.4). A variable set
  after the `AppModule` has loaded is never seen.
- **Every `beforeAll` runs after the file's static imports have loaded.** A suite that needs its
  own value therefore sets it and then loads the app modules with a dynamic `import()`:
  `DEFAULT_CURRENCY=EUR` in `cart-default-currency` and `price-read-default-currency`, and
  `RESERVATION_SWEEP_INTERVAL_SECONDS` in `reservation-sweeper`, `reservation-sweeper-cron` and
  `concurrent-sweep-release`. Set too late, the variable is ignored and the suite can pass while
  proving nothing.
- **`NOTIFIER_TEST_FLAKY` is the exception.** The `NOTIFIER` factory reads `process.env` when the
  container is built, so `notifications-retry` sets it in `beforeAll` before
  `createMicroservice` (`apps/notification-microservice/src/modules/notifications/notifications.module.ts`).
- **An override does not leak into the next spec file.** Jest gives each file its own copy of
  `process.env` and its own `globalThis`, even in one process under `-i`. The same copy is why
  setting `TZ` inside a test does not move the zone
  ([`event-store.md`](event-store.md#parseinstant)).

## Booting the services

- **A suite boots, in its own `beforeAll`, only the deployables its flow reaches.** A microservice
  is `NestFactory.createMicroservice(<App>Module, { transport: Transport.RMQ, … })` on its queue,
  then `listen()`. The gateway is `NestFactory.create(ApiGatewayAppModule)` and `init()`, and
  requests go through `supertest(app.getHttpServer())`. `afterAll` closes each one.
- **No `main.ts` runs.** Each gateway suite repeats `setGlobalPrefix('api')` and the global
  `ValidationPipe` options by hand, so a change to the gateway's `main.ts` pipeline has to be
  copied into the suites. The tracer is never imported, so the e2e run produces no spans.
- **The event store is booted one of two ways.** A suite that reads the event-store tables directly
  boots only the firehose transport: `event_store_firehose_queue` on the `ris.events` topic
  exchange, bound to `#` with `wildcards: true`. A suite that calls `/api/audit/*` or
  `/api/health` boots the hybrid form of the service's `main.ts`, because the gateway's event-store
  client sends to `event_store_query_queue`. Why `init()` must come first is in
  [`event-store.md`](event-store.md#boot).
- **Calls that do not start together need a listening server.** When the HTTP server is not
  listening, each `supertest(...)` call binds an ephemeral port and closes it when its own response
  ends (`supertest` 7.2.2, `Test.serverAddress` and `Test.end`). Calls fired in one tick are served,
  but a call that starts later can find the listener closed and fail with `ECONNRESET`. The staggered
  sweep race therefore calls `listen(0)` first (`test/concurrent-sweep-release.e2e-spec.ts`).
- **Suites reach inside the containers.** `app.get(<class or token>, { strict: false })` returns a
  use case to call directly, mostly one with no route: Commit Sale, Restock From Return, the two
  purges, the stale-claim report and the delivery sweeper. It also returns a port to spy on: the
  payment gateway, to count captures or fail an authorization, and the order publisher. `test/**`
  is outside the `boundaries` rules, and `no-restricted-imports` is off there (`eslint.config.mjs`).
  That is what lets a suite import an `AppModule`, a `ClientProxy` or an adapter class.
- **A synthetic event goes out through a test `ClientProxy`.** `ClientProxyFactory.create` builds it
  on a service's queue, or on `ris.events` with `wildcards: true`. `emit` publishes at once, whether
  or not anything subscribes; `firstValueFrom(emit(...))` only waits until the publish is confirmed
  (`@nestjs/microservices` 11.1.19, `ClientProxy.emit`).

## One database for every suite

Every suite runs against the same `retail_db`, `ris_eventstore`, Redis and broker, and
`yarn test:e2e:run` can run again on top of an earlier run without a reload. The suites keep out
of each other's way like this:

- **Fixtures are self-provisioned.** A suite creates its own products, variants, prices and stock
  through the API, and its slugs, SKUs and emails carry a `Date.now()` stamp. The category suite
  builds its tree from the `menswear` family, which the seed does not use.
- **Few suites change seeded rows.** The cart and order suites reserve and allocate seeded
  variants 1 and 3 for `customer@example.com`, so those counters drift during a run. Variant 2 is
  never reserved or allocated, which is why `inventory-availability` can assert its seeded
  `available` of 100 exactly. `catalog-media` archives every active asset on product 1, the seeded
  ones included, so that it owns the whole strip its reorder must permute. The audit suites record a
  staff action by re-assigning `warehouse-staff` its existing role, a valid call that changes
  nothing.
- **Assertions are relative.** A count is scoped to the suite's own correlation id, order id or
  reference. Where a result is table-wide, such as the number of rows a purge deleted, the suite
  asserts `>=` and checks its own rows one by one. The stale-claim report is measured as a delta
  against a baseline taken in the same test.
- **A sweep acts on every stale row, not just the suite's.** The reservation-sweep suites run one
  sweep during setup to drain holds an earlier run left behind. The orphaned-`queued` suite deletes
  its seeded rows afterwards.
- **Shared templates are extended, not replaced.** A suite that authors a new `retail.order.placed`
  version keeps `{{orderNumber}}` in the body, so the suite that asserts on the order number passes
  whichever ran first. A version the suite later deactivates is authored under the `en-GB` locale,
  which no dispatch resolves ([`notifications.md`](notifications.md#renderanddispatchusecase)).

## Waiting for asynchronous work

- **What crosses an `@EventPattern` is polled, with a deadline of 20–30 s.** That covers the
  auto-init `stock_level` row, event-store ingest, notification deliveries, the auto-refund from
  `OrderCancelledConsumer` and the consent cache. A marketing send is repeated with a fresh
  `campaignId` until the consent change shows, since each send is a distinct delivery row.
- **What an RPC does before it answers is checked at once.** The release on Cancel Order, Commit Sale
  on Ship and the restock on Inspect finish before the HTTP response
  ([`retail-orders.md`](retail-orders.md#ship-fulfillment),
  [`retail-returns.md`](retail-returns.md#inspect-and-disposition)), and the movements read is
  uncached.
- **Other than a poll's interval and the sweep race's deliberate stagger, a fixed sleep has one of
  two jobs.** One is to leave time before asserting that something did not happen, such as a second
  event row, a second sale row or a duplicate stock level. The other is the wait of just over a
  second between setting a price and publishing it or adding it to a cart, because a price set
  "now" can be stored up to half a second in the future
  ([`catalog-and-pricing.md`](catalog-and-pricing.md#prices)).
- **The auto-init row is polled in MySQL before the first stock read over HTTP.** A read taken
  earlier caches an answer with no locations, which nothing invalidates
  ([`inventory.md`](inventory.md#the-availability-cache)).

## Reading and writing MySQL directly

The helpers in `test/data-source/*.e2e-spec.data-source.ts` extend TypeORM's `DataSource` with raw
SQL. They read the rows no API exposes: the `customer` row after an erase, the payment's
`refunded_amount_minor` and `flagged_for_refund`, `idempotency_key`, `reservation`,
`notification_delivery` and the two event-store logs. Most extend
`InventoryAutoInitE2ESpecDataSource` for its `stock_level` poll. The event-store helper is opened
on `EVENTSTORE_DATABASE_URL`.

- **Numbers come back as strings.** TypeORM's MySQL driver turns on `supportBigNumbers` and
  `bigNumberStrings` unless told otherwise (`typeorm` 0.3.28, `MysqlDriver`), so a `BIGINT` id and a
  `COUNT(*)` arrive as strings. A `TINYINT(1)` arrives as a number, a `JSON` column as an object
  and a `TIMESTAMP` as a `Date`. The helpers coerce with `Number(...)`.
- **A helper that binds a JS `Date` must be opened with `timezone: 'Z'`,** as
  `DatabaseModule.forRoot` is. Without it `mysql2` writes the host's local wall clock, and the
  application reads it back as UTC. An aged row then lands the host's UTC offset away from where
  the suite put it, which is enough to hide a row from a horizon of minutes. The capture-claim helper
  sidesteps this by computing `NOW() - INTERVAL … MINUTE` in MySQL. The retention helper binds a
  `Date` without the pin, and its 100-day age against a 90-day horizon leaves room for any offset.
- **Setting `updated_at` in an `UPDATE` stops MySQL's `ON UPDATE CURRENT_TIMESTAMP`** from
  re-stamping it. That is what lets a helper age a `payment` row and change its status in one
  statement (`CaptureClaimE2ESpecDataSource.agePayment`).
- **The test-only writes are the ones no API can produce:** a reservation aged past its TTL, a
  payment stranded in `capturing`, a delivery aged or stuck in `queued`, an `idempotency_key` row
  with a chosen `expires_at`, and a bare `cart` row that satisfies the reservation's foreign key.
  Seeded deliveries have a null `recipient_customer_id`, so they get no `delivery_dedupe_key` and
  collide with nothing.
- **The purges take their clock as an argument.** `PurgeExpiredIdempotencyKeysUseCase.execute(now)`
  and `PurgeAgedDeliveriesUseCase.execute(now)` let a suite move time forward without waiting or
  touching the system clock.

## Failure modes

| What breaks                                                                         | How it shows                                                      | What recovers it                                                                      |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A route reaches a service the suite did not boot, or the query transport is missing | The test times out after 120 s instead of failing fast            | Boot that service, or the event store's hybrid form                                   |
| An environment variable is set after the `AppModule` loaded                         | The override is ignored; the suite may pass while proving nothing | Set it first and load the app modules with a dynamic `import()`                       |
| Staggered `supertest` calls against a server that is not listening                  | `ECONNRESET` on the later call                                    | `listen(0)` before the calls                                                          |
| A helper binds a `Date` without `timezone: 'Z'`                                     | A row aged by minutes is off by the host's UTC offset             | Pin the helper's connection to UTC, or do the arithmetic in MySQL                     |
| A stock read over HTTP before auto-init ran                                         | The variant keeps answering with no locations until the cache TTL | Poll `stock_level` first                                                              |
| A timer registered through `SchedulerRegistry` is not deleted on close              | The Jest worker never exits                                       | Delete it in `onModuleDestroy` ([`inventory.md`](inventory.md#the-reservation-sweep)) |
