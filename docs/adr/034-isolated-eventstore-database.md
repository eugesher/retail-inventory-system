# ADR-034: An isolated `ris_eventstore` database for the event store

- **Date**: 2026-06-26
- **Status**: Accepted

---

## Context

A new, sixth deployable is being introduced — the **event-store microservice**
(`apps/event-store-microservice/`). Its job is to be an append-only sink for two
streams:

- the **event firehose** — every business event published anywhere in the system
  (the `catalog.*`, `inventory.*`, `retail.*`, `notification.*` events), captured by a
  `#.#` topic-exchange binding; and
- the **staff audit log** — the "who did what, when" trail that the
  `AUDIT_LOG_PUBLISHER` seam already emits from the money-touching flows (refunds) and
  the auth/IAM mutations.

The firehose is, by construction, the **highest-volume write stream in the system**:
it persists a row for *every* event the other five services emit, and it only ever
grows. It is also write-mostly — ingestion is the live path; querying it is a later,
low-frequency capability.

Every existing durable-state context shares one logical database, `retail_db`, on a
single MySQL instance. Most recently [ADR-033](033-notification-templates-deliveries-and-render-dispatch.md)
made a deliberate decision for the notification service to **join `retail_db`** rather
than provision its own database, on the grounds that a second database "buys
cross-database joins and a second connection for no isolation benefit" — the
notification tables are low-volume and read in the same operational plane as everything
else.

The event store is the **opposite case**, and this ADR records why it diverges from
ADR-033's shared-database stance.

No production data exists, so this is a clean addition — there is no migration of an
existing schema.

## Decision

The event-store microservice persists to an **isolated logical database**,
`ris_eventstore`, on the **same MySQL instance** as `retail_db`. Isolation means:

### A separate schema, connection, and migration history

- **Schema** — `ris_eventstore` is a distinct MySQL database (schema), created by a
  one-time init script (`scripts/mysql-init/01-create-eventstore-db.sql`) mounted into
  the `mysql` container's `/docker-entrypoint-initdb.d/`. It runs only on a fresh data
  volume and grants the existing `retail` user full privileges on the new schema.
- **Connection** — the event store opens its TypeORM connection from a new env var,
  `EVENTSTORE_DATABASE_URL` (docker-compose default
  `mysql://retail:retailpass@mysql:3306/ris_eventstore`), via a second
  `DatabaseModule` factory, `DatabaseModule.forRootWithUrl(entities, urlEnvVar)`. The
  pre-existing `forRoot(entities)` is preserved unchanged — it now delegates to
  `forRootWithUrl(entities, 'DATABASE_URL')`, so the shared UTC pin,
  `synchronize: false`, and `SnakeNamingStrategy` are defined once. The event store is
  the *only* service that opens this connection; the other five never read it.
- **Migration history** — a **second migration pipeline** governs the new schema. A
  parallel data-source (`migrations/config/eventstore-data-source.ts`) reads
  `EVENTSTORE_DATABASE_URL` and globs `migrations/eventstore/*` — disjoint from the
  operational `migrations/*` glob (which is non-recursive and so never reaches the
  `eventstore/` subfolder). A `migration:*:eventstore` script family
  (`migration:run:eventstore`, `:revert:`, `:show:`, `:create:eventstore`) drives it,
  and each schema keeps its own `migrations` ledger table. The infra-reload sequence
  runs **both** (`migration:run && migration:run:eventstore && test:seed`).

`EVENTSTORE_DATABASE_URL` is a **required** key in the shared Joi config
(`libs/config`), validated at boot like `DATABASE_URL` — so a misconfigured event store
fails fast. Because the config schema is shared by every service, the var is set (to the
same value) in every docker-compose service block and in the env examples, even though
only the event store opens the connection.

### Why isolation, here, when ADR-033 chose sharing

The deciding factor is **write volume and growth profile**, not joins. The firehose's
append load and unbounded growth must not pressure the **operational** tables that serve
live checkout and inventory reads — buffer-pool pressure, larger backups, and longer
`ANALYZE`/maintenance windows on a single fat schema would degrade the hot path.
Isolating the firehose in its own schema:

- keeps the operational `retail_db` lean (its working set stays the live order /
  inventory / catalog data);
- lets the event log be **truncated or archived independently** later (a retention job
  can `TRUNCATE`/partition `ris_eventstore` tables without touching operational data);
- gives the firehose its own migration cadence, so event-schema churn never interleaves
  into the operational migration history.

There is no cross-database join requirement — the event store reads nothing from
`retail_db`; it only ingests events off the bus and persists them. So ADR-033's
"a second DB buys joins you don't need" objection does not apply: there are no joins to
lose.

The cost is **one extra connection + one extra migration run**, accepted deliberately.

## Alternatives Considered

- **Share `retail_db` (the ADR-033 stance).** Rejected. It couples the
  highest-volume, fastest-growing, append-only stream in the system to the operational
  tables, exactly the pressure isolation is meant to avoid. It would also force one
  combined migration history and make independent truncation/archival of the event log
  impossible without risking operational data. ADR-033's reasoning held for the
  low-volume notification tables; it inverts for the firehose.
- **A separate physical MySQL instance (or a purpose-built event store such as
  EventStoreDB / Kafka).** Rejected for this project's scope. A second instance (or a
  new datastore technology) adds real operational overhead — another container to run,
  monitor, back up, and secure, plus a second connection-pool topology — for isolation
  benefits a separate *schema on the same instance* already delivers at the volumes a
  portfolio system sees. Keeping one MySQL instance preserves the single-`docker compose
  up` local story while still separating the schemas.

## Consequences

- A new env var `EVENTSTORE_DATABASE_URL` is required by the shared config and therefore
  present (same value) across every service's environment, the env examples, and every
  docker-compose service block — not because the other services use it, but because the
  one Joi schema validates it for all.
- `DatabaseModule` grows a second root factory, `forRootWithUrl(entities, urlEnvVar)`;
  `forRoot` is now a thin delegate to it. Any future service that needs a non-default
  connection URL can reuse `forRootWithUrl`.
- There are now **two** migration pipelines. A contributor adding an event-store table
  uses `yarn migration:create:eventstore <Name>` (scaffolds into `migrations/eventstore/`)
  and `yarn migration:run:eventstore`; operational tables keep the unchanged
  `migration:create` / `migration:run`. CI/infra-reload runs both.
- The local stack gains a sixth container (`event-store-microservice`) and a MySQL init
  mount. `yarn test:infra:down` drops the volume, so the next `test:infra:up` re-runs
  the init script and recreates the `ris_eventstore` schema before the dual migration
  run.
- The event store boots as a plain RMQ listener on `event_store_firehose_queue` (the
  default exchange) and **idles** — no `@EventPattern` handlers are bound yet. The
  `ris.events` topic-exchange binding with `#.#` wildcards, the `domain_event` /
  `audit_log_entry` tables, the firehose consumer, and the audit-publisher swap are
  later capabilities; this ADR records only the isolated-database decision and the shell
  that realizes it.

## References

- [ADR-033](033-notification-templates-deliveries-and-render-dispatch.md) — the
  notification service's decision to **join** `retail_db`; this ADR records the
  deliberate divergence for the high-volume firehose.
- [ADR-018](018-nestjs-monorepo-apps-and-libs.md) — a new deployable is a new
  `apps/<name>/` + a `nest-cli.json` project + a per-app `tsconfig.app.json`.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — TypeORM + MySQL, migrations via
  the CLI, `synchronize` off, `BaseEntity` — honored by the second pipeline.
- [ADR-007](007-pino-and-opentelemetry.md) — the tracer-first `main.ts` rule the new
  service upholds.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the `apps/*/src/...`
  boundary globs that already cover a canonically-laid-out new service.
