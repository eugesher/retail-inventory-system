# Exercising the new endpoints by hand

This capability added four HTTP routes: three audit reads under `/api/audit`
([`06-audit-proxy-endpoints-and-pagination.md`](06-audit-proxy-endpoints-and-pagination.md)) and
one on-demand reservation sweep at `POST /api/inventory/reservations/sweep`
([`03-manual-sweep-admin-endpoint.md`](03-manual-sweep-admin-endpoint.md)). This note describes
how to drive all four from a request file, in either of the two libraries the repository keeps —
and the handful of things about them that are easy to get wrong.

## 1. Two libraries, one contract

Every gateway endpoint exists in **both** request libraries:

- **[`http/kulala/`](../../../http/kulala)** — one `*.http` file per gateway area, in the
  standard `.http` format (Kulala, REST Client, IntelliJ HTTP Client all read it).
- **[`http/posting/`](../../../http/posting)** — a [Posting](https://posting.sh) collection: one
  subcollection folder per `.http` file, one `*.posting.yaml` per request, and a `scripts.py`
  beside each folder's requests.

Neither is the source of truth. They are two renderings of the same flows, and an endpoint is
not delivered until it exists in both. [`http/posting/README.md`](../../../http/posting/README.md)
carries the mapping table between them, plus the per-folder request counts — which are
re-derived from `ls`, never incremented by hand, so a drifted count is a real signal.

Both libraries now hold the same 17 areas. The new `audit` area contributes 11 requests, and
`inventory` grew by 2 for the sweep.

## 2. The audit collection

[`http/kulala/audit.http`](../../../http/kulala/audit.http) and
[`http/posting/audit/`](../../../http/posting/audit) run **top to bottom**. Each request
demonstrates one thing:

| # | Request | What it demonstrates |
| ---: | --- | --- |
| 1 | `login` | The seeded admin (`admin@example.com`). Captures the bearer into `accessToken`. Also *writes* an audit row — a staff login emits `UserLoggedIn`. |
| 2 | `warehouseLogin` | A seeded staff token **without** `audit:read`. Captures `warehouseAccessToken`. |
| 3 | `queryEventsByAggregate` | The firehose read, scoped to one aggregate instance. Captures a real correlation id out of its first row. |
| 4 | `queryEventsByCorrelation` | The same log, scoped to one request's cross-service chain. |
| 5 | `queryEventsByTypeAndRange` | One event type inside one inclusive `from`/`to` window. |
| 6 | `queryEventsInvertedRange` | `from > to` → `400`, from the gateway DTO. |
| 7 | `queryEventsForbidden` | The warehouse token → `403`, from `PermissionsGuard`, before any RPC. |
| 8 | `queryEntriesByAction` | The staff trail, scoped to one **event-name** string. See §5. |
| 9 | `queryEntriesByActor` | Everything one staff principal did. |
| 10 | `traceByCorrelation` | Both logs for the captured id, each ordered forward in time. |
| 11 | `traceUnknownCorrelation` | An unknown id → `200` with two empty arrays, never a `404`. |

**The chaining.** Request 3 is the producer: its first result row carries a real
`correlationId`, and requests 4 and 10 consume it. Nothing else in the collection mints one —
a correlation id is minted by `CorrelationMiddleware` when an HTTP request arrives, so the only
way to obtain a *real* one is to read it back out of the log.

That is also why order 3 → 4 → 10 matters, and why the collection cannot be run bottom-up. If
`queryEventsByAggregate` comes back empty (a freshly seeded database has no domain events — the
seed writes catalog and identity rows, not events), place an order first via
[`http/kulala/order.http`](../../../http/kulala/order.http) and re-run.

The two reads and the trace disagree about ordering, on purpose, and running 4 and 10 back to
back makes it visible: `queryEventsByCorrelation` returns the chain **newest-first** (the "what
just happened" default), while `traceByCorrelation` returns it **oldest-first** (a timeline
reads forward). Same rows, opposite direction.

## 3. The sweep block

Two requests, in [`http/kulala/inventory.http`](../../../http/kulala/inventory.http) and their
Posting twins `inventory/sweep-reservations.posting.yaml` and
`inventory/sweep-reservations-custom-batch.posting.yaml`:

- `sweepReservations` — no body. Expires every `active` hold whose TTL has elapsed, up to the
  service's configured `RESERVATION_SWEEP_BATCH_SIZE`.
- `sweepReservationsCustomBatch` — `{ "batchSize": 5 }`. The value is an upper bound the
  inventory service **clamps** into `[1, RESERVATION_SWEEP_BATCH_SIZE]`; a gateway DTO with a
  `@Max` would be a second copy of an operational property. `{"batchSize": 0}` is a `400`
  (shape); `{"batchSize": 10000}` is a `200` (magnitude is the service's business).

Both return `{ scanned, expired, skipped, durationMs }`, and `scanned = expired + skipped`
always.

**Why a second run reports `expired: 0`.** The sweep is idempotent by construction. The set it
acts on is `status = 'active' AND expires_at < now`, and acting on a row *removes it from that
set* — the hold flips to `expired`. So the second call scans, finds nothing that matches, and
answers `{ scanned: 0, expired: 0, skipped: 0 }`. This is exactly why the route needs no
`Idempotency-Key`: ADR-036's four money- and stock-moving writes need the header because a
replay would double the effect, and this one cannot.

Run the two back to back and the second one's zero is the demonstration. To see the *first* one
reclaim something, add a cart line (which reserves), wait out `RESERVATION_TTL_MINUTES`, then
sweep — or set `RESERVATION_SWEEP_INTERVAL_SECONDS` high enough that the service's own timer
does not beat you to it.

## 4. Kulala inline references vs Posting session variables

This is the one structural difference between the libraries, and every `scripts.py` in
`http/posting/` exists because of it.

Kulala chains **declaratively**. A later block interpolates an earlier response inline:

```http
# @name queryEventsByAggregate
GET {{baseUrl}}/audit/events?aggregateType=order&aggregateId=1&pageSize=50
Authorization: Bearer {{accessToken}}

###
@tracedCorrelationId = {{queryEventsByAggregate.response.body.$.items[0].correlationId}}
```

Posting has no such reference. Instead the **producer** publishes a session variable from an
`on_response` hook, and the **consumer** reads it back as `$name`. From
[`http/posting/audit/scripts.py`](../../../http/posting/audit/scripts.py):

```python
def capture_query_events_by_aggregate(response, posting) -> None:
    """queryEventsByAggregate -> $tracedCorrelationId (the first row's correlationId)."""
    items = response.json()["items"]
    if items:
        posting.set_variable("tracedCorrelationId", items[0]["correlationId"])
```

wired onto the request that produces it:

```yaml
# audit/query-events-by-aggregate.posting.yaml
scripts:
  on_response: audit/scripts.py:capture_query_events_by_aggregate
```

and consumed by name:

```yaml
# audit/trace-by-correlation.posting.yaml
url: $ENV_BASE_URL/audit/trace/$tracedCorrelationId
```

Note what the hook does **not** do: when the page is empty it sets nothing. Posting substitutes
with a strict `string.Template`, so `trace-by-correlation` then fails loudly with a
`SubstitutionError` instead of silently tracing an empty string or a stale id. That failure is
the correct one — it says *"your producer returned no rows"*, which is a fact about the
database, not about the request file. (An empty target would be actively wrong:
`domain_event.correlation_id` is `NOT NULL DEFAULT ''`, so `''` is the sentinel for "ingested
without a correlation id" and matches every such row.)

The same `on_response` shape carries `$accessToken` out of `login` and `$warehouseAccessToken`
out of `warehouse-login`, so the `403` demonstration has a token that genuinely lacks the
permission rather than a hand-pasted one.

## 5. Why the audit action filter takes an event-name string

This is the single most likely thing for a reader to get wrong, so both libraries say it inline
and this note repeats it.

`GET /api/audit/entries?action=…` matches `audit_log_entry.action`, which holds the stable
**event-name** string — `StaffUserRolesAssigned`, `RefundIssued`, `UserLoggedIn` — and **not**
the permission code that gated the route which produced the row. Pass a `PermissionCodeEnum`
value (any `<area>:<verb>` string) and you get a `200` with an empty page, which is the worst
possible failure, because it looks like an answer.

The mapping is fixed at the publisher, in `toAuditStaffActionEvent`:

```
action     ← event.name           (the stable event-name string)
actorType  ← event.actorKind === 'staff' ? 'staff-user' : 'system'
entityType ← event.targetKind
entityId   ← event.targetId
```

[ADR-035](../../adr/035-event-store-firehose-topic-exchange.md) fixes that `action ← name` row.
The in-process `IAuditLogEvent.name` a use case supplies (`name: 'StaffUserRolesAssigned'` in
`assign-staff-role.use-case.ts`) is what lands in the column, and permission codes never enter
that path at all — they are consumed by `PermissionsGuard`, which runs and then gets out of the
way long before anything is audited.

The names in circulation today: `UserLoggedIn`, `LoginFailed`, `LogoutPerformed`,
`RefreshTokenRotated`, `RefreshFailed`, `RefreshReuseDetected`, `StaffUserRegistered`,
`StaffUserRolesAssigned`, `StaffUserRoleRevoked`, `RoleCreated`, `RolePermissionsReplaced`,
`CustomerRegistered`, `CustomerLoggedIn`, `CustomerLoginFailed`, `CustomerErased`,
`RefundIssued`. The authoritative list is whatever `grep -rn "name: '" apps/*/src/modules/*/application/use-cases/`
returns — there is no enum, by design: the audit log records what happened, and a closed
vocabulary would make it lie by omission the first time a new action shipped without one.

## 6. Running them

Both libraries need the full stack up, both migration pipelines run, and the seed applied. The
audit reads additionally need the **event-store microservice** running: it is the only consumer
of `event_store_query_queue`, and with nothing listening the gateway hangs on an RPC reply that
never arrives rather than failing fast (see
[`06-audit-proxy-endpoints-and-pagination.md`](06-audit-proxy-endpoints-and-pagination.md) §7).

```bash
docker compose up -d
yarn migration:run
yarn migration:run:eventstore
yarn test:seed
yarn start:dev            # all six services
```

**Kulala** reads its environment from
[`http/kulala/http-client.env.json`](../../../http/kulala/http-client.env.json), whose `dev`
entry sets `ENV_BASE_URL=http://localhost:3000/api`. Open `http/kulala/audit.http`, select the
`dev` environment, and send the blocks in order.

**Posting** is launched at the collection root, so that the `scripts.py` paths in each request
(`audit/scripts.py:capture_login`) resolve:

```bash
posting --collection http/posting --env http/posting/dev.env
```

`dev.env` mirrors the Kulala `dev` environment. To check the collection parses without opening
the TUI, load it directly:

```bash
python -c "
from posting.collection import Collection
c = Collection.from_directory('http/posting')
print(sum(len(x.requests) for x in [c, *c.children]))"   # → 200
```

**The seeded credentials** both libraries use come from
[`scripts/test-db-seed.ts`](../../../scripts/test-db-seed.ts):

| Email | Password | Role | Reaches `/api/audit/*`? |
| --- | --- | --- | --- |
| `admin@example.com` | `admin1234` | `admin` (every permission code) | yes |
| `warehouse@example.com` | `warehouse1234` | `warehouse-staff` | **no** — `403` |
| `catalog@example.com` | `catalog1234` | `catalog-manager` | **no** — `403` |
| `support@example.com` | `support1234` | `order-support` | **no** — `403` |

`audit:read` is bound to `admin` alone. The sweep route is different: it gates on
`inventory:adjust`, which `admin` **and** `warehouse-staff` both carry.

## 7. Related reading

- [`06-audit-proxy-endpoints-and-pagination.md`](06-audit-proxy-endpoints-and-pagination.md) —
  the three audit routes: their filters, their permission gate, where validation lives, and why
  nothing here ever returns a `404`.
- [`03-manual-sweep-admin-endpoint.md`](03-manual-sweep-admin-endpoint.md) — the sweep route:
  why it reuses `inventory:adjust`, why it needs no `Idempotency-Key`, and what `actorId`
  distinguishes.
- [`http/posting/README.md`](../../../http/posting/README.md) — the Kulala → Posting mapping
  table, the per-folder request counts, and the shared-vs-fresh idempotency-key convention.
- [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md) — the `action ← name` mapping
  §5 rests on.
- [ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md) — the four writes that
  require an `Idempotency-Key`, and by contrast why the sweep does not.
