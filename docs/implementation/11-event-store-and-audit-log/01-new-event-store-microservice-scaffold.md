# The event-store microservice scaffold + the isolated `ris_eventstore` database

This document introduces the **sixth deployable** in the system — the
`event-store-microservice` — and the second logical database it owns,
`ris_eventstore`. This change is **shell-only**: it brings the service into existence
so it boots and idles on RabbitMQ against its own schema. The tables, repositories,
firehose consumer, and audit-log machinery land in subsequent work and are called out
as such below.

## 1. What this service is

The event store is an **append-only sink** for two streams the rest of the system
already produces:

- the **event firehose** — every business event published anywhere in the system (the
  `catalog.*`, `inventory.*`, `retail.*`, and `notification.*` events). A later
  capability binds a `ris.events` topic exchange with `#.#` wildcards so the service's
  queue receives all of them; and
- the **staff audit log** — the "who did what, when" trail the `AUDIT_LOG_PUBLISHER`
  seam already emits from the money-touching flows (refunds) and the auth/IAM
  mutations.

It is **ingestion-only** for now: persisting the streams is the live path; querying the
stored history back out is a later capability. The bounded context is
`audit-and-events`, split into two empty sibling modules that later work fills in:

- `modules/domain-events/` — the firehose sink (the future `domain_event` table); and
- `modules/audit-log/` — the staff audit trail (the future `audit_log_entry` table).

A context-level `AuditAndEventsModule` aggregates the two so the composition root
imports one module.

## 2. Topology

The event store sits where every other microservice sits — behind RabbitMQ, with no
HTTP surface of its own:

```
                   ┌───────────────────────────────────────────┐
   business events │  api-gateway · retail · inventory · …      │
        ──────────▶│  (publish onto RabbitMQ)                   │
                   └───────────────────────────────────────────┘
                                    │
                                    ▼  event_store_firehose_queue
                   ┌───────────────────────────────────────────┐
                   │        event-store-microservice           │
                   │   audit-and-events context:               │
                   │     • domain-events/  (firehose sink)      │
                   │     • audit-log/      (staff trail)        │
                   └───────────────────────────────────────────┘
                                    │
                                    ▼
                          ris_eventstore  (its own schema)
```

`main.ts` boots a `NestFactory.createMicroservice` RMQ listener on
`event_store_firehose_queue`, bound to the **default exchange** with a durable queue —
the same bootstrap shape the notification microservice uses. It registers **no**
`@MessagePattern` / `@EventPattern` handlers yet, so the service connects to RabbitMQ
and its database and then idles, logging that it is listening. (A later capability
re-points this connection at the `ris.events` topic exchange with `#.#` wildcards so the
queue receives the whole firehose.)

The service identity:

| Property                | Value                                                  |
| ----------------------- | ------------------------------------------------------ |
| App / OTel service name | `event-store-microservice`                             |
| Consumer queue          | `event_store_firehose_queue`                           |
| Logical database        | `ris_eventstore` (same MySQL instance as `retail_db`)  |
| Runtime DB env var      | `EVENTSTORE_DATABASE_URL`                              |

As with every app, `main.ts`'s first executable import is the observability tracer
(`@retail-inventory-system/observability/tracer`) so OpenTelemetry auto-instrumentation
patches the AMQP / TypeORM clients before they are required (see
[ADR-007](../../adr/007-pino-and-opentelemetry.md)).

## 3. Why an isolated `ris_eventstore` database

The full rationale is recorded in
[ADR-034](../../adr/034-isolated-eventstore-database.md); the short version:

The notification microservice, when it gained persistence
([ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md)),
**joined the shared `retail_db`** on the grounds that a second database buys
cross-database joins and a second connection for no isolation benefit. The event store
is the opposite case and deliberately diverges:

- the firehose is the **highest-volume, write-mostly, ever-growing** stream in the
  system (a row per event, for every event, forever), so its append load and growth
  must **not pressure the operational tables** that serve live checkout and inventory
  reads;
- the event log should be **independently truncatable / archivable** by a future
  retention job without touching operational data; and
- there is **no cross-database join requirement** — the event store reads nothing from
  `retail_db`; it only ingests events off the bus — so ADR-033's "joins you don't need"
  objection does not apply.

Isolation is a **separate schema on the same MySQL instance** (not a separate physical
instance), which keeps the local stack a single `docker compose up` while still
separating the two schemas, their connections, and their migration histories. The cost
is one extra connection and one extra migration run, accepted deliberately.

## 4. The second migration pipeline

`ris_eventstore` is governed by its **own** migration pipeline, fully parallel to the
operational one and disjoint from it:

- **Data-source** — `migrations/config/eventstore-data-source.ts` reads
  `EVENTSTORE_DATABASE_URL` and globs `migrations/eventstore/*` (it mirrors the dotenv +
  Joi guard of the operational `migrations/config/data-source.ts`, but requires the
  event-store URL). The operational data-source globs `migrations/*` **non-recursively**,
  so it never reaches the `eventstore/` subfolder — the two histories never interleave,
  and each schema keeps its own `migrations` ledger table.
- **Folder** — `migrations/eventstore/` (holds a `.gitkeep` until the first event-store
  table migration lands).
- **Scripts** — a `migration:*:eventstore` family in `package.json`:
  `migration:run:eventstore`, `migration:revert:eventstore`, `migration:show:eventstore`,
  and `migration:create:eventstore <Name>` (which scaffolds into `migrations/eventstore/`).
  The create script is the generalized `scripts/migration-create.ts` — it now accepts an
  optional `--dir <subdir>` flag; with no flag the operational `migration:create` behaves
  exactly as before.
- **Schema provisioning** — `scripts/mysql-init/01-create-eventstore-db.sql` is mounted
  into the `mysql` container's `/docker-entrypoint-initdb.d/`. It runs **once, on a fresh
  data volume, after** the MySQL entrypoint has created the `retail` user, and issues
  `CREATE DATABASE IF NOT EXISTS ris_eventstore` + `GRANT ALL PRIVILEGES ON
  ris_eventstore.* TO 'retail'@'%'`. Because `test:infra:down` drops the volume, the next
  `test:infra:up` re-runs the init script and recreates the schema.
- **Infra reload** — `test:infra:reload` now runs **both** migration families:
  `migration:run && migration:run:eventstore && test:seed`.

`EVENTSTORE_DATABASE_URL` is a **required** key in the shared Joi config
(`libs/config`), so it is set — to the same value — in every service's environment, the
docker-compose service blocks, and the env examples, even though only the event store
opens the connection. The connection itself is opened by a new second factory,
`DatabaseModule.forRootWithUrl(entities, urlEnvVar)`; the pre-existing
`DatabaseModule.forRoot(entities)` is unchanged in behavior (it now delegates to
`forRootWithUrl(entities, 'DATABASE_URL')`), preserving the UTC `timezone: 'Z'` pin,
`synchronize: false`, and `SnakeNamingStrategy`.

## 5. Boot + verify

From a clean checkout with Docker available:

```bash
# 1. Bring up infra (a fresh volume runs the MySQL init that creates ris_eventstore)
docker compose up -d mysql redis rabbitmq

# 2. Apply both migration histories
yarn migration:run               # retail_db
yarn migration:run:eventstore    # ris_eventstore  (currently: "No migrations are pending")

# 3. Boot the event store — it connects to RabbitMQ + ris_eventstore and idles
yarn start:dev:event-store-microservice
# → logs: "Event Store Microservice is listening for messages"
#   the event_store_firehose_queue now exists in RabbitMQ with no bound handlers
```

Quality gates:

```bash
yarn lint          # ESLint (max-warnings 0), incl. the architecture-boundary rules
yarn test:unit     # Jest unit suites
yarn test:e2e      # full infra reload (runs BOTH migration families) + e2e suites
```

`yarn start:dev` (or the `--reload` variant) now boots all six services concurrently,
the event store included.
