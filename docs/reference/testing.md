# Testing

This file covers the two Jest configurations, the end-to-end harness under `test/` and the five
repository self-checks under `spec/`. For the harness it covers how a suite boots the services,
where configuration is read, how suites share one database, how they wait for asynchronous work, and
the helpers that read and write MySQL directly. For the self-checks it covers what each one asserts,
what a red run means and how to fix it. Their rationale is in
[ADR-017](../adr/017-architecture-lint-via-eslint-boundaries.md) (architecture lint),
[ADR-049](../adr/049-the-port-methods-nothing-calls.md) (port-method callers),
[ADR-053](../adr/053-how-a-transition-window-closes.md) (transition windows),
[ADR-055](../adr/055-where-deliberately-unbuilt-work-is-recorded.md) (extension guides) and
[ADR-064](../adr/064-code-carries-no-comments.md) (no code comments). The
commands, the capability-to-suite map and the "assert through public state" rule are in
[`README.md` §9](../../README.md#testing). The seed data the suites start from is in
[§10](../../README.md#10-seed-data), and the seeded logins are in [§1](../../README.md#seeded-logins).

## Running

- **Two configurations.** `jest.unit.config.js` runs every `*.spec.ts` under the repository root,
  which includes `spec/`. `jest.e2e.config.js` runs `test/**/*.e2e-spec.ts` and adds the setup file.
  Both build `moduleNameMapper` from `compilerOptions.paths` in `tsconfig.json`
  (`ts-jest`'s `pathsToModuleNameMapper`), so a new `@retail-inventory-system/*` alias needs only
  its `tsconfig.json` entry.
- **Every spec file runs serially in one process.** `test:unit`, `test:e2e:run` and `test:run` all
  pass `-i` (`package.json`). Jest orders the files by its own cache of earlier runs, so no suite may
  depend on another having run first.
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

## Repository self-check specs

The five files in `spec/` test the repository rather than a service, and run in `yarn test:unit`.
Each one fails with a message that names what to change. None of them is made green by an allowlist
or by loosening its own assertions.

### `architecture-lint.spec.ts`

- **It lints its fixtures with the production config as ESLint resolves it.** `beforeAll` runs
  `npx eslint --print-config` on `PROBE_FILE`, a gateway use case the `boundaries` block applies to.
  It then builds a `Linter` from the answer's `boundaries/elements`, `boundaries/dependencies` and
  `boundaries/no-unknown-files`. The config is taken after every block has been merged, so a lower
  severity, a narrower `disallow` and a later block that overrides an earlier one all reach the
  fixtures. If the probe comes back with no `boundaries/elements`, `beforeAll` throws instead of
  letting every fixture pass.
- **ESLint runs as a child process because it cannot run inside Jest.**
  `ESLint#calculateConfigForFile` loads `eslint.config.mjs` with a dynamic `import()`, and Jest's VM
  sandbox rejects it with "A dynamic import callback was invoked without --experimental-vm-modules"
  (checked against Jest 29.7.0 and ESLint 10.1.0). The spawn happens once, under a 120 s hook
  timeout.
- **Three tests read the config itself:**
  - `no-unknown-files` and `dependencies` are at `error`;
  - `dependencies` denies by default;
  - `shared-module-barrel` comes before `nest-module`.

  A fixture cannot catch the first two, because it only asks whether a ruleId is reported. The
  order is also caught by the `auth`-barrel fixture, which goes red when the barrel is typed
  `nest-module`. The severity test is a second line of defence: `yarn lint` runs with
  `--max-warnings 0`, so a `warn` would still fail CI today.

- **The fixtures are the independent expectation.** Each one writes an import into a virtual file
  at a path the element patterns place, then asserts the ruleId. A fixture that crosses elements
  imports a real file, because the plugin types the target by its resolved path
  ([ADR-017](../adr/017-architecture-lint-via-eslint-boundaries.md) §7). An import of a file that
  does not exist reports nothing. So when a target file moves, a fixture that expects a violation
  goes red, but one that expects none keeps passing and proves nothing.
- **The event store's two repositories are checked as text.** A structural block reads
  `domain-event-typeorm.repository.ts` and `audit-log-entry-typeorm.repository.ts` and asserts four
  things about each file:
  - it declares `export class …TypeormRepository implements I…RepositoryPort`;
  - it does not `extends BaseTypeormRepository`;
  - it declares `public async append(`;
  - nowhere in the file is `save`, `update`, `delete`, `softDelete` or `remove` followed by `(`.

  The last check is a regular expression over the source, so the same word in a string or a query
  builder call turns it red too.

- **When it goes red:** make the code satisfy the rule, and move a misplaced file to where
  `yarn lint` says it belongs ([`architecture-lint.md`](architecture-lint.md)). A red fixture after an
  `eslint-plugin-boundaries` upgrade means the plugin's semantics changed. Understand the change
  before touching the config.

### `port-method-callers.spec.ts`

Every callable member of a port has a production caller
([ADR-049](../adr/049-the-port-methods-nothing-calls.md)).

- **What is scanned:** each top-level `interface` in a file under
  `apps/*/src/modules/*/application/ports/`. A member counts if it is a method signature or a
  property whose type is a function type; overloads count once. Ports in `libs/`, such as
  `ITransactionPort`, `ICachePort` and `IAuditLogPublisher`, are not scanned, and neither are `type`
  aliases.
- **What counts as a caller:** a reference found by TypeScript's find-references. It has to be the
  name in a property access `x.member`, where `x` is not a bare `this`. It also has to sit in a file
  under `apps/` that is not in a `spec/` folder and is not a `*.spec.ts` or `*.e2e-spec.ts` file. A
  call through the implementing class's type counts. An adapter's `this.member()` does not, and
  neither does a call from `libs/`, `test/` or `scripts/`. The check does not look at reachability,
  so a call from dead code counts.
- **Why it is a spec and not a lint rule.** Whether anything calls a member depends on the whole
  program: deleting the last call in one file changes the verdict for a port in another. ESLint
  lints and caches file by file, so it would not re-check the port.
- **Blind spots, both false reds:** an element access (`repo['member']()`) and a destructured method
  (`const { member } = repo`) are not recognised. Write the call plainly.
- **It checks that it can fail.** The language service is built over the root `tsconfig.json`, which
  has no `include`, so it takes every `.ts` under the root. On top of that it adds an in-memory
  fixture app, `__port-callers-fixture__`. The host reports the fixture's directories as existing,
  because module resolution skips a candidate whose directory does not exist. The first test pins
  the four fixture members the scan must report. The second test pins that the set of scanned apps
  equals the directories under `apps/`. The scan takes about 20 s, under a 300 s hook timeout.
- **When it goes red:** delete the method from the port, its adapter and its spec. If the adapter
  needs it internally, make it private on the adapter instead (ADR-049 §1–§2). Never allowlist it.

### `transition-windows.spec.ts`

`OPEN_WINDOWS` is the register of obligations queued behind a condition. The rule, the three tests
and what does not belong in the register are in
[ADR-053](../adr/053-how-a-transition-window-closes.md).

- **The fields:**
  - `id` is a stable handle for the failure message;
  - `what` is the obligation;
  - `condition` is the event that discharges it, which somebody must be able to notice;
  - `owner` is a ticket or a person, not "the team";
  - `reviewBy` is an ISO date;
  - `adr` is `ADR-NNN`.
- **`reviewBy` is read as midnight UTC.** A date-only ISO string parses as UTC, so a window turns
  red at 00:00 UTC on its review day and stays red after that. A malformed date is rejected by the
  second test, since `Invalid Date` compares `false` against everything.
- **When it goes red:** discharge the obligation, or move the date on purpose and say why in the
  commit, or delete the entry with the reasoning. Never delete it just to turn CI green (ADR-053).

### `extension-guides.spec.ts`

It enforces the guide contract written in
[`docs/extensions/README.md`](../extensions/README.md#how-these-guides-are-written): front matter,
the cluster folder, the six sections, and live `attaches_to` paths
([ADR-055](../adr/055-where-deliberately-unbuilt-work-is-recorded.md)). Beyond that contract:

- **The folder's size is pinned.** `EXPECTED_TOTAL` (64) and `EXPECTED_PER_CLUSTER` are literals. A
  guide added, deleted or moved to another cluster means editing them and the matching table in
  `docs/extensions/README.md` in the same change. `CLUSTER_DIRS` spells out the nine folder names
  instead of deriving them, so renaming a folder fails until the map is edited too.
- **Front matter is parsed by hand.** The parser reads `key: value` lines and one indented list
  (`attaches_to`); it knows nothing else about YAML. A quoted value is compared with its quotes.
- **Headings are compared as text.** A guide must have exactly the six `## ` lines, in order, and
  no other; a `## ` line inside a fenced code block counts. The `title` must equal the first `# `
  line.
- **Two words and a path are banned.** A guide or the index fails if it contains `tmp/`, or the
  whole word "epic" or "task" in any case. The spec builds those strings from fragments so that it
  does not contain them itself.
- **Links are checked by file, not by anchor.** Every relative link in a guide and in the index must
  resolve once its `#fragment` is cut off; `http(s)` and `mailto:` links are skipped. In the index,
  only a link of the form `<folder>/<file>.md` counts as a guide row, and every guide must be linked
  exactly once.

### `no-code-comments.spec.ts`

The code carries no comments, apart from functional directives
([ADR-064](../adr/064-code-carries-no-comments.md)).

- **What is scanned:** every file `git ls-files --cached --others --exclude-standard` lists, minus
  `.yarn/`, so a new file is checked before it is staged. Each file is scanned by its type:
  - `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs` — parsed by TypeScript, and every
    leading and trailing comment range around every token is collected. A comment inside a string, a
    template or a regular expression is not a comment range, so it is never reported;
  - `.sql` — `--`, `#` and `/* */` outside a `'…'`, `"…"` or `` `…` `` literal;
  - `Dockerfile*`, `.yml`, `.yaml`, `.sh`, `.env`, `.env.example`, `.toml`, `.py`, `.gitignore`,
    `.dockerignore` and `.husky/*` — a line whose first non-blank character is `#`, except a shebang
    on line 1;
  - `.http` — a line starting with `#` or `//`, except a bare `###` and a `# @…` / `// @…` directive.
- **The directives are one array, `DIRECTIVES`.** A comment is kept when its text, with the comment
  markers stripped, starts with one of them: `eslint-disable…` / `eslint-enable`, `global`,
  `@ts-expect-error` / `@ts-ignore` / `@ts-nocheck` / `@ts-check`, `prettier-ignore`,
  `istanbul ignore` / `c8 ignore`, a webpack magic comment, `/// <reference … />`, and a JSDoc
  `@type` / `@typedef` / `@satisfies` in a `.js`, `.mjs` or `.cjs` file only. In a `.ts` file that
  JSDoc is prose and is reported.
- **Blind spots, all false greens:** a trailing `#` comment in YAML, shell, a Dockerfile or `.env`;
  a Python docstring; SQL comments inside a TypeScript string, such as a migration's DDL. ADR-064 §4
  says why each is left to review.
- **It checks that it can fail.** The first four tests run the detector over in-memory fixtures:
  a TypeScript source with a comment of every kind and every directive, read once as `.ts` and once
  as `.mjs`; SQL with comment markers inside and outside quotes; a shell file and an `.http` file.
  Each pins the exact line numbers it must report. Another test pins that the scan sees more than a
  thousand code files, this spec among them, and nothing under `.yarn/`.
- **When it goes red:** delete the comment. If it said something true that the code does not, write
  that in the area's file here in `docs/reference/`, or in an ADR if it is a decision. Never
  allowlist it, and never add a directive to hide it.

## Failure modes

| What breaks                                                                         | How it shows                                                                                 | What recovers it                                                                      |
| ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A route reaches a service the suite did not boot, or the query transport is missing | The test times out after 120 s instead of failing fast                                       | Boot that service, or the event store's hybrid form                                   |
| An environment variable is set after the `AppModule` loaded                         | The override is ignored; the suite may pass while proving nothing                            | Set it first and load the app modules with a dynamic `import()`                       |
| Staggered `supertest` calls against a server that is not listening                  | `ECONNRESET` on the later call                                                               | `listen(0)` before the calls                                                          |
| A helper binds a `Date` without `timezone: 'Z'`                                     | A row aged by minutes is off by the host's UTC offset                                        | Pin the helper's connection to UTC, or do the arithmetic in MySQL                     |
| A stock read over HTTP before auto-init ran                                         | The variant keeps answering with no locations until the cache TTL                            | Poll `stock_level` first                                                              |
| A timer registered through `SchedulerRegistry` is not deleted on close              | The Jest worker never exits                                                                  | Delete it in `onModuleDestroy` ([`inventory.md`](inventory.md#the-reservation-sweep)) |
| A port method is called only as `repo['m']()` or through destructuring              | `port-method-callers` reports it as uncalled                                                 | Write the call as `repo.m()`                                                          |
| An `architecture-lint` fixture's target file is moved or renamed                    | A fixture expecting a violation goes red; one expecting none passes without proving anything | Point the fixture's import at the file's new path                                     |
| A guide or the extensions index contains `tmp/`, "epic" or "task"                   | `extension-guides` goes red                                                                  | Reword it                                                                             |
| A transition window's `reviewBy` arrives                                            | `transition-windows` goes red from 00:00 UTC that day                                        | Discharge it, or move the date and say why in the commit (ADR-053)                    |
| A comment is added anywhere the self-check scans                                    | `no-code-comments` goes red with its `file:line`                                             | Delete it; move what it said to `docs/reference/` or an ADR (ADR-064)                 |
