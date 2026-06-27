# The staff audit log: publisher swap and ingestion into `audit_log_entry`

This document covers how the staff audit log reaches the event store, end to end. It
has two halves:

- **the publisher swap** (§1–§4) — retiring the log-only no-op audit adapters and
  replacing them with a real RMQ publisher that emits `audit.staff.action` onto the
  `ris.events` topic exchange; and
- **the ingestion side** (§5) — the event store's firehose consumer routing
  `audit.staff.action` to the audit-log ingest, which maps it 1:1 into the append-only
  `audit_log_entry` table.

It builds on the `ris.events` topology from
[02-topic-exchange-ris-events-and-dual-publish.md](02-topic-exchange-ris-events-and-dual-publish.md),
the firehose consumer + domain-event ingest in
[03-domainevent-ingestion-and-idempotency.md](03-domainevent-ingestion-and-idempotency.md),
and the decision in [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md).

## 1. The audit seam before the swap

The system already emits audit events through a stable port,
[`AUDIT_LOG_PUBLISHER`](../../../libs/contracts/auth/audit-log-publisher.port.ts), at
every privileged-action call site. Each site builds an in-process `IAuditLogEvent`:

```ts
interface IAuditLogEvent {
  name: string;                              // 'UserLoggedIn', 'StaffUserRolesAssigned', 'RefundIssued', …
  actorId: string | null;
  actorKind: 'staff' | 'customer' | 'anonymous';
  targetId: string | null;
  targetKind: 'staff-user' | 'customer' | 'role' | 'permission' | null;
  payload: Record<string, unknown>;
  correlationId: string | null;
  occurredAt?: Date;
}
```

Until this change, both bindings of the port resolved a `NoOpAuditLogPublisher` — a
deliberate "this deployment has no audit sink yet, so route the event to a Pino debug
line" adapter. There were exactly **two** bindings, because there are exactly two audit
call sites in the system:

- the **api-gateway `auth` module** — login (`UserLoggedIn` / `LoginFailed`), logout,
  refresh-token rotation/reuse, staff + customer registration, and (through the module's
  `AUDIT_LOG_PUBLISHER` **export**) the `iam` role mutations (`RoleCreated`,
  `RolePermissionsReplaced`, `StaffUserRolesAssigned`, `StaffUserRoleRevoked`); and
- the **retail `orders` module** — the always-audit refund money movements
  (`RefundIssued` / `RefundFailed`), for both the manual refund and the
  auto-refund-from-cancel consumer.

No other service has an `AUDIT_LOG_PUBLISHER` binding or call site, so no other service
is touched here — an audit adapter anywhere else would be dead code.

## 2. The real adapter and the `IAuditLogEvent → IAuditStaffActionEvent` mapping

The no-op is replaced by `RmqAuditLogPublisher` in each of the two services
([auth](../../../apps/api-gateway/src/modules/auth/infrastructure/audit/rmq-audit-log.publisher.ts),
[orders](../../../apps/retail-microservice/src/modules/orders/infrastructure/audit/rmq-audit-log.publisher.ts)).
The retail copy is a deliberate duplicate of the gateway's — the two deployables cannot
import each other across the service boundary
([ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md) /
[ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)), the same reason the
no-ops were duplicated.

Each adapter injects the `RIS_EVENTS_PUBLISHER` topic-exchange `ClientProxy` (lives only
in `infrastructure/`, [ADR-009](../../adr/009-port-adapter-at-the-gateway.md)) and maps
the in-process event onto the wire contract
[`IAuditStaffActionEvent`](../../../libs/contracts/auth/audit-staff-action.event.ts) — a
transport-flattened projection so the event store never imports a producer's internal
types. **Call sites are unchanged**; they still build the same `IAuditLogEvent`. Only the
binding moved from logging to RMQ.

| Wire field (`IAuditStaffActionEvent`) | Source (`IAuditLogEvent`) |
| --- | --- |
| `action` | `event.name` — the stable event-name string |
| `actorType` | `event.actorKind === 'staff' ? 'staff-user' : 'system'` (customer / anonymous → `'system'`) |
| `entityType` | `event.targetKind` (nullable) |
| `entityId` | `event.targetId` (nullable) |
| `before` | `event.payload.before ?? null` |
| `after` | `event.payload.after ?? (the whole payload)` |
| `occurredAt` | `(event.occurredAt ?? new Date()).toISOString()` |
| `correlationId` | `event.correlationId ?? ''` |
| `ipAddress` | `null` (always — see §4) |
| `eventVersion` | `'v1'` |

### The before/after convention

The in-process `payload` is free-form, so the adapter applies a simple rule: when the
call site supplies explicit `before` / `after` keys, use them; otherwise record the
**whole** payload as `after` and leave `before` null. Most call sites (login, refund)
carry a flat detail payload with no before/after keys, so their entire payload lands in
`after` — e.g. a `RefundIssued` event records `{ orderId, paymentId, refundId,
amountMinor, currency, reason, … }` as `after`. A site that does model a transition (a
role's permission set changing) can pass `{ before, after }` and the adapter forwards
them verbatim.

### The emit

The mapped event is published best-effort:

```ts
await firstValueFrom(
  risEventsClient.emit(ROUTING_KEYS.AUDIT_STAFF_ACTION, wire),
);
```

Per [ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md), a rejected `emit` is
warn-logged and **swallowed** — audit is post-commit fan-out and must never block the
mutation that already happened. The retail refund use case `await`s the audit call (the
money-movement is always audited), which is safe precisely because the adapter never
rethrows its own broker failures.

The actual `action` values on the wire are the event-name strings the call sites already
emit — `UserLoggedIn`, `LoginFailed`, `LogoutPerformed`, `RefreshTokenRotated`,
`StaffUserRolesAssigned`, `StaffUserRoleRevoked`, `RoleCreated`, `RolePermissionsReplaced`,
`StaffUserRegistered`, `CustomerLoggedIn`, `CustomerRegistered`, `RefundIssued`,
`RefundFailed` — not a synthetic verb like `iam:assign`.

## 3. The cleanup: deleting the no-ops

The swap is a conflict-resolution cleanup, so the old adapters are **removed outright**,
not renamed or kept beside the new ones:

- `apps/api-gateway/src/modules/auth/infrastructure/audit/no-op-audit-log.publisher.ts`
  (and its spec) — deleted;
- `apps/retail-microservice/src/modules/orders/infrastructure/audit/no-op-audit-log.publisher.ts`
  — deleted.

Every dangling reference is updated in the same change: the two `audit/index.ts`
re-exports now point at `rmq-audit-log.publisher`; both module providers
([auth.module.ts](../../../apps/api-gateway/src/modules/auth/auth.module.ts),
[orders.module.ts](../../../apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts))
import `MicroserviceClientRisEventsModule` and rebind `{ provide: AUDIT_LOG_PUBLISHER,
useExisting: RmqAuditLogPublisher }`. Crucially, the **`AUDIT_LOG_PUBLISHER` export** in
`auth.module.ts` is preserved — the `iam` use cases consume the port through that export
and have no binding of their own. The existing use-case specs were already injecting
their own `IAuditLogPublisher` fakes (not the no-op class), so they stay green with the
no-op gone; two new specs lock the real adapters' mapping and best-effort behavior.

## 4. The `ipAddress` gap

`ipAddress` is always `null`. No audit call site threads the originating request IP into
the `IAuditLogEvent` today — the gateway audit points run inside use cases that do not
receive the raw request, and the retail refund path runs in a microservice with no HTTP
context at all. The wire field exists and is reserved so the ingest schema is stable when
IP capture is added (threading `request.ip` through the gateway audit points). It is a
known, documented gap, not an oversight.

## 5. The ingestion side: routing `audit.staff.action` into `audit_log_entry`

The other end of the wire now exists. The event store's single
[`FirehoseConsumer`](../../../apps/event-store-microservice/src/modules/firehose.consumer.ts)
(see [03-domainevent-ingestion-and-idempotency.md](03-domainevent-ingestion-and-idempotency.md)
§1) reads each message's concrete routing key and dispatches:

```ts
if (routingKey === ROUTING_KEYS.AUDIT_STAFF_ACTION) {
  await this.ingestAuditLog.execute(payload as IAuditStaffActionEvent);
} else {
  await this.ingestDomainEvent.execute(routingKey, payload);
}
```

So `audit.staff.action` is the **one** routing key handled by the audit-log branch;
everything else is a raw firehose event. An audit action lands **only** in
`audit_log_entry`, never also in `domain_event` — the two logs stay distinct.

### The 1:1 map

[`IngestAuditLogUseCase`](../../../apps/event-store-microservice/src/modules/audit-log/application/use-cases/ingest-audit-log.use-case.ts)
maps the wire `IAuditStaffActionEvent` straight onto an `AuditLogEntry` — the inverse of
the publisher mapping in §2. The wire is already a transport-flattened projection, so the
ingest does no inference: `actorId`, `actorType`, `action`, `entityType`, `entityId`,
`before`, `after`, `ipAddress`, and `correlationId` copy across verbatim, and the ISO
`occurredAt` string is parsed to a `Date`. Then `AUDIT_LOG_REPOSITORY.append` inserts the
row.

### No idempotency key — and why that is correct

Unlike the firehose log, `audit_log_entry` has **no** dedupe UNIQUE (see
[06-append-only-enforcement.md](06-append-only-enforcement.md)). An audit trail records
*occurrences*: two identical staff actions a second apart are two genuine events, not a
duplicate, so collapsing them would lose information. `append` therefore always inserts.
The at-least-once guarantee means a redelivery could in principle write a second row, but
audit publishing is rare, post-commit, and best-effort — the trade-off favors never
dropping a real action over de-duplicating a redelivery, the opposite call from the
high-volume firehose.

### Validation and the never-rethrow posture

Two load-bearing columns are validated before the insert; a violation is a **warn +
drop**, never an exception (ADR-011 §7 — a throw inside an `@EventPattern` blind-redelivers
in a hot loop):

- an `actorType` outside `{staff-user, system}` (the two-value origin axis) → dropped;
- an absent or unparseable `occurredAt` → dropped (the audit timeline cannot be defaulted).

Any thrown persist error is likewise caught, warn-logged, and swallowed. The message is
acked in every case.

> Before this branch was wired, an emitted `audit.staff.action` was published onto
> `ris.events` and — with no `#` consumer bound — dropped by the broker as unrouted. It
> now lands in `audit_log_entry`. The `ipAddress` gap (§4) persists end to end: the column
> is populated with the wire value, which is always `null` today.
