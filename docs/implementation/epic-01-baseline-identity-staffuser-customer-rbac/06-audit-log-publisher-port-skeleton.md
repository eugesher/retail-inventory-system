# 06 — Audit-log publisher port skeleton

This document records the forward-compatibility scaffolding for the
audit-log work that lands in epic-11. Epic-01 ships the application-port
interface, a DI symbol, and a default *no-op* adapter that writes a Pino
debug line; epic-11 will swap the binding to an RMQ publisher and stand
up the `audit_log_entry` table without re-touching a single auth/IAM use
case.

Sibling implementation notes:
[`01-staffuser-customer-split.md`](./01-staffuser-customer-split.md),
[`02-role-and-permission-relational-model.md`](./02-role-and-permission-relational-model.md),
[`03-permissions-guard-and-decorator.md`](./03-permissions-guard-and-decorator.md),
[`04-customer-register-and-login.md`](./04-customer-register-and-login.md),
[`05-iam-admin-endpoints.md`](./05-iam-admin-endpoints.md).

## 1. Why ship the port now

Audit-log call sites are *cross-cutting* — they live inside every
mutation use case in the auth + IAM modules. If the port were introduced
in epic-11 alongside the real RMQ publisher, that PR would have to touch
every one of those use cases:

- `LoginUseCase`, `RefreshTokenUseCase`, `LogoutUseCase`
- `RegisterStaffUserUseCase`, `RegisterCustomerUseCase`, `LoginCustomerUseCase`
- `CreateRoleUseCase`, `UpdateRoleUseCase`,
  `AssignStaffRoleUseCase`, `RevokeStaffRoleUseCase`

By landing the port + no-op adapter inside epic-01 (alongside the
StaffUser/Customer split, the relational RBAC schema, the permissions
guard, and the IAM admin surface), epic-11's scope reduces to:

1. Swap the `AUDIT_LOG_PUBLISHER` binding from `NoOpAuditLogPublisher`
   to an RMQ-publisher adapter.
2. Stand up the event-store microservice and the `audit_log_entry`
   table.
3. Wire `GET /audit-log` behind the existing `audit:read` permission
   (seeded by task-02; today only the `/api/auth/admin/ping` smoke
   endpoint exercises it).

None of the auth + IAM use cases change.

## 2. Port shape

The port lives in `libs/contracts/auth/audit-log-publisher.port.ts` so
both the gateway and future off-gateway consumers (e.g., the event-store
microservice's projection workers) can depend on the same pure
TypeScript surface. Per the lib-contracts denylist in
`eslint.config.mjs`, this file cannot import Nest DI decorators —
exactly the property we want for a transport-agnostic contract.

```ts
export const AUDIT_LOG_PUBLISHER = Symbol('AUDIT_LOG_PUBLISHER');

export interface IAuditLogEvent {
  name: string;                  // 'UserLoggedIn', 'RoleCreated', …
  actorId: string | null;        // null for pre-auth events
  actorKind: 'staff' | 'customer' | 'anonymous';
  targetId: string | null;
  targetKind: 'staff-user' | 'customer' | 'role' | 'permission' | null;
  payload: Record<string, unknown>;
  correlationId: string | null;
  occurredAt?: Date;             // publisher-set, not caller-set
}

export interface IAuditLogPublisher {
  publish(event: IAuditLogEvent): Promise<void>;
}
```

The `actorKind` field exists because **StaffUser ids and Customer ids
share no namespace** (ADR-024). An audit consumer that sees an
`actorId` alone cannot tell which id-space it belongs to; `actorKind`
disambiguates without forcing a UUID-prefix convention that would leak
into the rest of the codebase.

The signature uses `Promise<void>` even for the no-op so the contract
doesn't change when the RMQ adapter (which awaits an AMQP publish
confirm) lands. Every call site `await`s `publish` — that aligns with
[ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md)'s
convention that asynchronous side-effects are explicitly awaited inside
the use case (no fire-and-forget).

## 3. No-op semantics

The default adapter is bound inside
`apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts`:

```ts
NoOpAuditLogPublisher,
{ provide: AUDIT_LOG_PUBLISHER, useExisting: NoOpAuditLogPublisher },
```

…and re-exported so the IAM module (which imports `AuthModule`) sees
the same singleton. The adapter writes a Pino `debug` line under a
constant context `'AuditLog'`:

```bash
LOG_LEVEL=debug yarn start:dev:api-gateway
# … log in to the gateway from another terminal …
# Search the dev log:
yarn start:dev:api-gateway 2>&1 | grep '"context":"AuditLog"'
```

The no-op is **not** a stub waiting to be replaced. Its semantics are
"this deployment has no durable audit log yet, so route the event to
logs." When the real adapter lands in epic-11, that's a *deployment*
change (`useClass`/`useExisting` swap), not a code change at the call
sites.

## 4. Event catalogue

| Use case                        | Event name(s) emitted                                |
| ------------------------------- | ---------------------------------------------------- |
| `LoginUseCase`                  | `UserLoggedIn`, `LoginFailed`                        |
| `RefreshTokenUseCase`           | `RefreshTokenRotated`, `RefreshFailed`, `RefreshReuseDetected` |
| `LogoutUseCase`                 | `LogoutPerformed`                                    |
| `RegisterStaffUserUseCase`      | `StaffUserRegistered`                                |
| `RegisterCustomerUseCase`       | `CustomerRegistered`                                 |
| `LoginCustomerUseCase`          | `CustomerLoggedIn`, `CustomerLoginFailed`            |
| `CreateRoleUseCase`             | `RoleCreated`                                        |
| `UpdateRoleUseCase`             | `RolePermissionsReplaced`                            |
| `AssignStaffRoleUseCase`        | `StaffUserRolesAssigned` (carries the *added* diff)  |
| `RevokeStaffRoleUseCase`        | `StaffUserRoleRevoked`                               |

The contract is the event *name*. Payload details vary per use case but
all keep to camelCase keys and stay well under 1 KB (long values belong
on the resource row, not the audit row). Every site has a per-event
spec assertion that the publisher is called exactly once with the
expected `{ name, actorId, actorKind, targetId, targetKind, payload,
correlationId }` shape (see `*.use-case.spec.ts` files under
`apps/api-gateway/src/modules/{auth,iam}/application/use-cases/spec/`).

## 5. What epic-11 will change

| Change                                    | Where                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------- |
| RMQ publisher adapter                     | `apps/api-gateway/src/modules/auth/infrastructure/audit/rmq-audit-log.publisher.ts` (new) |
| Adapter binding swap                      | `auth.module.ts` — `useExisting: RmqAuditLogPublisher`                 |
| `audit_log_entry` table + projection      | A new event-store microservice                                         |
| `GET /audit-log` endpoint                 | A new presentation controller, gated by the existing `audit:read` code |

The use cases, the port shape, the no-op adapter file, and the existing
spec files **do not change** — epic-11 deletes the no-op binding line
and adds the RMQ binding line. That's the whole point of investing in
this skeleton up front.

## 6. Correlation id seam (a known shortcut)

Today the use cases receive the correlation id by command-field
threading: each command DTO carries an optional
`correlationId?: string | null`, the controllers pull it via
`@CorrelationId()` (from `@retail-inventory-system/observability`), and
the use cases pass it straight into the audit event. The relevant
seam points:

- `libs/observability/correlation-id.decorator.ts` — `@CorrelationId()`
  reads `request.headers['x-correlation-id']` (set or generated by
  `CorrelationMiddleware`).
- Auth controllers under
  `apps/api-gateway/src/modules/auth/presentation/` — `auth.controller.ts`,
  `staff-login.controller.ts`, `customer-auth.controller.ts`.
- IAM controller — `apps/api-gateway/src/modules/iam/presentation/iam.controller.ts`.

This is a *deliberate shortcut*. The cleaner long-term solution is a
request-scoped `CorrelationContext` provider injected into the use
cases directly — that removes the `correlationId` field from every
command DTO and avoids the "controller is now responsible for stitching
in a request-bound primitive" coupling. Epic-11 should replace the
command-field plumbing with that provider in the same PR that swaps in
the RMQ adapter; this doc is the audit record so we don't forget.
