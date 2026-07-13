# ADR-044: A system health surface — `GET /api/health` fanned out over RabbitMQ

- **Date**: 2026-07-12
- **Status**: Accepted

---

## Context

The structural audit ([`docs/audits/audit-2026-07-12-structural-symmetry.md`](../audits/audit-2026-07-12-structural-symmetry.md), `SYM-006`) recorded the health surface as an asymmetry: one service of six had a `health.controller.ts`, five did not.

Looking at it inverted the finding. `notification.health.ping` had **no caller at all**:

- the gateway exposed no health route;
- no e2e suite, no `http/` collection, no script called it;
- `docker-compose.yml` carries `healthcheck` blocks for RabbitMQ, MySQL and Redis only — the services themselves do not run in compose.

So the system did not have five services missing a health check. It had **one dead RPC**, and a six-deployable distributed system with no liveness surface whatsoever.

That reframing decides the shape of the fix. Simply adding a ping to the other five would produce six dead RPCs instead of one: the value of a liveness probe is entirely in its **consumer**. Nothing is worth building here unless something asks the question.

## Decision

### 1. Every RMQ deployable answers `<svc>.health.ping`

Five new/kept `@MessagePattern` handlers, one per deployable: `catalog.health.ping`, `inventory.health.ping`, `retail.health.ping`, `notification.health.ping` (the existing one), `audit.health.ping` (the event store — its RPC namespace is `audit.*`, ADR-039).

Each rides the service's **existing** RPC queue. No new queue, no new exchange, nothing to provision. The event store is probed on `event_store_query_queue`, its default-exchange RPC transport — never on the `#`-bound firehose queue: a health ping is a command, and the query transport's `wildcards: false` exact-match lookup resolves it while the firehose's `#` cannot.

**The handler does no I/O.** It answers exactly one question — *is a Nest app consuming this queue?* — because that is the only question a single RPC can answer honestly. This is a **liveness** probe, not a readiness probe. A service whose MySQL is down still replies `ok`, and that is correct: a DB round-trip would turn every health poll into load on the hot path, and one slow database would report five services as sick.

### 2. The controllers live in `app/`, not in a module

`apps/<svc>/src/app/health.controller.ts`, registered in `AppModule`'s `controllers`.

Liveness is a property of the **deployable**, not of any bounded context inside it. Retail makes that plain: it holds three modules (`cart`, `orders`, `returns`), and *"which module owns the service's health?"* has no answer. The gateway's `app/filters/` is the same idea already — an app-level concern that sits outside the hexagon. The notification service's existing controller moves out of `modules/notifications/presentation/` for the same reason.

Under the boundaries taxonomy these files are `app-bootstrap`, whose allow list already covers `lib-contracts` + `lib-messaging` — no rule change.

### 3. The gateway is the consumer: `GET /api/health`

A new `modules/health/` following the gateway's standard RPC-fronting shape — `application/ports` (`HEALTH_GATEWAY_PORT`, `HEALTH_PROBE_TIMEOUT_MS`), `application/use-cases` (`CheckHealthUseCase`), `infrastructure/messaging` (`HealthRabbitmqAdapter`, the sole `ClientProxy` site), `presentation`.

It is the only gateway module that imports **every** `MicroserviceClient*Module`, because it is the only one that talks to every service.

- **Concurrent fan-out.** The five probes run together, so the endpoint's worst case is **one** timeout, not five.
- **The adapter never rejects.** Each probe resolves to a `ServiceHealthView` whichever way it goes — `ok` (with a measured `latencyMs`), `timeout`, or `error`. `Promise.all` is safe only because of that, and it is load-bearing: a rejecting probe would short-circuit the fan-out and lose the status of the services that *did* answer, which is precisely what the caller came for.
- **`timeout` is honest.** No reply within `HEALTH_PROBE_TIMEOUT_MS` means the service is down, wedged, or its queue has no consumer. The gateway cannot distinguish those and does not guess.
- **`@Public()`.** A monitor carries no JWT, and a health endpoint that can fail on authentication cannot answer the one question it exists for. It leaks nothing: service names are already in the README and the payload carries no data.

### 4. `degraded`, and always 200

`status` is `ok` only when **all five** answered `ok`; anything else is `degraded`. The verdict is deliberately harsh — a system missing its event store is not healthy because four of five services are. There is no `down`: the gateway answering at all proves the gateway is up.

The endpoint returns **200 in both cases**. This is a *report about the system*, not the gateway's own liveness signal. Returning 503 because notification is down would make the gateway look dead when it is the one component provably alive; a monitor reads `status` and the per-service map, not the HTTP code.

### 5. `HEALTH_PROBE_TIMEOUT_MS`

A Joi key (`.integer().min(100).default(2000)`) reaching the adapter through a value-provider token — a use case never reads `process.env`. It bounds **one** probe, not the fan-out.

## Consequences

### Positive

- The system has a liveness surface, and it has a consumer. The dead ping became a live capability instead of being deleted.
- One endpoint answers "is anything down, and what", over the **real transport** — the same broker the business traffic uses, so a probe failing means business traffic would fail too. A `latencyMs` that is climbing is an early warning about RabbitMQ or a struggling consumer, well before timeouts start.
- `SYM-006`'s health half is closed, and the remaining `SYM-006` items (the gateway admin shells) are confirmed as deliberate, not drift.

### Negative

- Liveness only. A service can answer `ok` with a dead database, and the endpoint will say the system is healthy. That is a stated limit, not an oversight — see §1. A readiness surface, if it is ever wanted, is a separate decision with a separate cost.
- The gateway now holds five `ClientProxy` instances it would otherwise not need. They connect lazily, so an unused health endpoint costs providers, not sockets.

### Open

- Nothing polls this yet. `docker-compose.yml` runs infrastructure only; the services are started with `yarn start:dev`. When they are containerised, `GET /api/health` is the natural `healthcheck` target for the gateway, and each service's ping is what an orchestrator's sidecar would call.

## Alternatives considered

- **Delete the dead ping.** Cheap and honest — symmetry restored at zero. Rejected: it leaves a six-deployable distributed system with no way to answer "is anything down", which is a real gap, not a stylistic one.
- **Add a ping to the other five and stop there.** This is the naive reading of "make it symmetric", and it produces six dead RPCs instead of one. A probe with no consumer is not a health surface.
- **Check the database / Redis inside each ping.** That is a *readiness* probe wearing a liveness probe's clothes. It puts a DB round-trip on every poll of a hot path, and it conflates "this service is running" with "everything it depends on is happy" — so one slow database reports five sick services. Rejected on both counts.
- **Return 503 when degraded.** Conventional for a *self* health check, wrong for a *system report*: it makes the gateway look dead because a downstream is, and it forces the monitor to parse an error response to learn which service is actually sick.
- **`Promise.allSettled` instead of `Promise.all`.** Equivalent here, because `probeOne` already swallows its own failures — but it would let the never-rejecting contract rot silently. `Promise.all` over a total function keeps that contract load-bearing, and it is stated in the port.

---

## References

- [ADR-009](009-port-adapter-at-the-gateway.md) — the gateway's RPC-fronting module shape the health module follows.
- [ADR-011](011-notifier-port-and-adapters.md) — §6, the RMQ-only stance that makes an RPC (not HTTP) the right probe for a microservice.
- [ADR-039](039-audit-and-event-store-query-surface.md) — `event_store_query_queue` and the `audit.*` namespace the event store's ping joins.
- [`docs/audits/audit-2026-07-12-structural-symmetry.md`](../audits/audit-2026-07-12-structural-symmetry.md) — `SYM-006`, the finding this closes.
