---
epic: epic-01
task_number: 7
title: Introduce `AUDIT_LOG_PUBLISHER` port + no-op default adapter; wire call sites in auth + IAM use cases
depends_on: [task-01, task-02, task-03, task-04, task-05, task-06]
doc_deliverable: docs/implementation/epic-01-baseline-identity-staffuser-customer-rbac/06-audit-log-publisher-port-skeleton.md
---

# Task 07 — `AUDIT_LOG_PUBLISHER` port + no-op default adapter

## Goal

Forward-compatibility scaffolding for the audit-log work that lands in epic-11. Introduce an application-port interface (`IAuditLogPublisher`), a DI symbol (`AUDIT_LOG_PUBLISHER`), and a default no-op adapter that writes a Pino debug line. Wire the call sites into every auth + IAM use case the epic flags as audit-relevant — so when epic-11 swaps in the real RMQ publisher, no use case has to change.

The no-op adapter is **not** a stub-to-be-replaced; it's a real adapter whose semantics are "this deployment has no audit log yet, so route the event to logs". The fact that epic-11 will bind a different adapter later is a *deployment* change, not a code change.

## Entry state assumed

Task-06 carryover present:

- `iam` module with five use cases.
- Auth module has `RegisterStaffUserUseCase`, `LoginUseCase`, `RefreshTokenUseCase`, `LogoutUseCase`, `RegisterCustomerUseCase`, `LoginCustomerUseCase`, `ValidateJwtSubjectUseCase`.
- Existing structured logging via Pino is in place — `PinoLogger` from `nestjs-pino` is already injected in every use case (e.g., `this.logger.warn({ email }, 'LoginFailed: user not found or inactive')` in `login.use-case.ts`).

## Scope

**In:**

- New `libs/contracts/auth/audit-log-publisher.port.ts` — the interface + DI symbol + the `IAuditLogEvent` shape consumed by callers.
- New `apps/api-gateway/src/modules/auth/infrastructure/audit/no-op-audit-log.publisher.ts` — the default adapter.
- Bind the no-op adapter to `AUDIT_LOG_PUBLISHER` inside `apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts`.
- Re-export the binding from the iam module (since it injects the same token).
- Inject + call the publisher at every audit-relevant site:
  - **Auth use cases**: `LoginUseCase` (events `UserLoggedIn`, `LoginFailed`), `RefreshTokenUseCase` (events `RefreshTokenRotated`, `RefreshFailed` + the special `RefreshReuseDetected`), `LogoutUseCase` (event `LogoutPerformed`), `RegisterStaffUserUseCase` (event `StaffUserRegistered`), `RegisterCustomerUseCase` (event `CustomerRegistered`), `LoginCustomerUseCase` (events `CustomerLoggedIn`, `CustomerLoginFailed`).
  - **IAM use cases**: `CreateRoleUseCase` (`RoleCreated`), `UpdateRoleUseCase` (`RolePermissionsReplaced`), `AssignStaffRoleUseCase` (`StaffUserRolesAssigned` with the *added* names diff), `RevokeStaffRoleUseCase` (`StaffUserRoleRevoked`).
- Add a per-event-shape spec asserting that each use case calls the publisher exactly once with the expected payload (use a mock implementation of the port).

**Out:**

- The real RMQ adapter that publishes to the event-store microservice — epic-11.
- The `audit_log_entry` table itself — epic-11.
- Any cross-service eventing / RabbitMQ wiring — epic-11.

## Port shape (concrete)

```ts
// libs/contracts/auth/audit-log-publisher.port.ts

export const AUDIT_LOG_PUBLISHER = Symbol('AUDIT_LOG_PUBLISHER');

export interface IAuditLogEvent {
  // Stable event-name string. Convention: <past-tense verb phrase>.
  // Examples: 'UserLoggedIn', 'StaffUserRolesAssigned', 'RoleCreated'.
  name: string;

  // The subject acting (StaffUser/Customer id) when known. Null for events
  // produced before authentication (e.g., 'LoginFailed: user not found').
  actorId: string | null;

  // The kind of subject acting. Audit consumers need this because actor ids
  // are not globally unique across the two id spaces in this epic.
  actorKind: 'staff' | 'customer' | 'anonymous';

  // The target resource the event mutates (e.g., the StaffUser id whose
  // roles were assigned, the Role id whose permissions were replaced).
  // Null for events that don't mutate a specific resource (e.g., LoginFailed).
  targetId: string | null;
  targetKind: 'staff-user' | 'customer' | 'role' | 'permission' | null;

  // Free-form structured payload. Use camelCase keys. Keep it under ~1KB —
  // long payloads belong on the resource itself, not on the audit row.
  payload: Record<string, unknown>;

  // Correlation id from `request.headers['x-correlation-id']` (propagated by
  // `CorrelationMiddleware`). Null when called outside a request context.
  correlationId: string | null;

  // Always set by the publisher implementation, not the caller — the caller
  // can pass it through if a deterministic timestamp is needed (rare).
  occurredAt?: Date;
}

export interface IAuditLogPublisher {
  publish(event: IAuditLogEvent): Promise<void>;
}
```

The interface uses `Promise<void>` even for the no-op so the contract doesn't change when the real adapter (which awaits an AMQP publish confirm) lands.

## No-op adapter

```ts
// apps/api-gateway/src/modules/auth/infrastructure/audit/no-op-audit-log.publisher.ts
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { IAuditLogEvent, IAuditLogPublisher } from '@retail-inventory-system/contracts';

@Injectable()
export class NoOpAuditLogPublisher implements IAuditLogPublisher {
  constructor(
    @InjectPinoLogger('AuditLog') private readonly logger: PinoLogger,
  ) {}

  public publish(event: IAuditLogEvent): Promise<void> {
    this.logger.debug(
      {
        actorId: event.actorId,
        actorKind: event.actorKind,
        targetId: event.targetId,
        targetKind: event.targetKind,
        correlationId: event.correlationId,
        payload: event.payload,
      },
      event.name,
    );
    return Promise.resolve();
  }
}
```

The `PinoLogger` context is `'AuditLog'` (constant) so a grep over Pino output isolates audit events cleanly even before the real publisher exists.

## Files to add

- `libs/contracts/auth/audit-log-publisher.port.ts` — bodies above.
- `apps/api-gateway/src/modules/auth/infrastructure/audit/no-op-audit-log.publisher.ts` — body above.
- `apps/api-gateway/src/modules/auth/infrastructure/audit/spec/no-op-audit-log.publisher.spec.ts` — verifies the adapter logs at `debug` with the event name as the message; returns a resolved promise.
- Per-use-case "publishes" assertions added to the existing spec files (no new spec files needed):
  - `apps/api-gateway/src/modules/auth/application/use-cases/spec/login.use-case.spec.ts` — assert `publish` is called once with `{ name: 'UserLoggedIn', actorId: <id>, actorKind: 'staff', ... }` on success; once with `{ name: 'LoginFailed', actorId: null, actorKind: 'anonymous', payload: { reason: 'user-not-found' | 'bad-password' } }` on each failure branch.
  - `apps/api-gateway/src/modules/auth/application/use-cases/spec/refresh-token.use-case.spec.ts` — happy path + rotation reuse + signature-failure branches.
  - `apps/api-gateway/src/modules/auth/application/use-cases/spec/logout.use-case.spec.ts`.
  - `apps/api-gateway/src/modules/auth/application/use-cases/spec/register-customer.use-case.spec.ts`.
  - `apps/api-gateway/src/modules/auth/application/use-cases/spec/login-customer.use-case.spec.ts`.
  - `apps/api-gateway/src/modules/iam/application/use-cases/spec/*.spec.ts` — one publish assertion per use case.

## Files to modify

- `libs/contracts/auth/index.ts` — `export * from './audit-log-publisher.port';`.
- `apps/api-gateway/src/modules/auth/infrastructure/auth.module.ts`:
  - Provide `NoOpAuditLogPublisher` and bind `{ provide: AUDIT_LOG_PUBLISHER, useExisting: NoOpAuditLogPublisher }`.
  - Add `AUDIT_LOG_PUBLISHER` to the module's `exports` so the iam module can inject it.
- `apps/api-gateway/src/modules/iam/iam.module.ts` — import `AuthModule` (already needed for the repository tokens); inject `AUDIT_LOG_PUBLISHER` in each IAM use case via the standard `@Inject(AUDIT_LOG_PUBLISHER)`.
- Every audit-relevant use case (listed under "Scope → In") — add a constructor-injected `@Inject(AUDIT_LOG_PUBLISHER) private readonly audit: IAuditLogPublisher` and a call to `await this.audit.publish({ ... })` at each event point. Important:
  - **`await` the publish call**. Even though the no-op resolves immediately, the contract is async — failing to await would silently break under the real adapter. Architecturally aligns with ADR-023's post-commit invalidation convention (asynchronous side-effects are explicitly awaited inside the use case).
  - Pass `correlationId` from the request context. The use cases today don't see the request directly — wire it through the existing `nestjs-pino` context, or, simpler, accept a `correlationId?: string` field on the existing command DTOs and have the controller pass `request.headers['x-correlation-id']` through. The cleaner long-term solution is a `CorrelationContext` provider; for now, the command-field approach is enough scaffolding and the doc deliverable should note it as a known seam to harden in epic-11.

## Files to delete

None.

## Tests

- New `no-op-audit-log.publisher.spec.ts`.
- Updated `*.use-case.spec.ts` per the list above: assert the publisher mock receives exactly one call per audit point, with the event-name and payload shape matching the table in this task.

## Doc deliverable

Write `docs/implementation/epic-01-baseline-identity-staffuser-customer-rbac/06-audit-log-publisher-port-skeleton.md`. Target ~100 lines. Sections:

1. **Why ship the port now.** Audit-log call sites are *cross-cutting* — they live inside every mutation use case. Adding them in epic-11 after-the-fact would mean a follow-on PR that touches every auth + IAM use case. By introducing the port + no-op adapter in this epic, epic-11's PR scope reduces to "swap the adapter binding" + "stand up the event-store microservice".
2. **Port shape.** Snippet of `IAuditLogEvent` + `IAuditLogPublisher`. Explain the `actorKind` field (staff vs customer ids share no namespace).
3. **No-op semantics.** Pino debug line under context `'AuditLog'`. How to grep for events in dev logs.
4. **Event catalogue.** Table mapping each use case → event name(s) emitted. Keep it short — the *contract* is the event name; payload details are use-case specific.
5. **What epic-11 will change.** A new adapter binding to an RMQ publisher; the `audit_log_entry` table in the event-store microservice; the `audit:read` permission becomes useful for the first time (it gates a future `GET /audit-log` endpoint). The auth + IAM use cases themselves do not change.
6. **Correlation id seam.** Today's command-field workaround is a known shortcut. epic-11 will replace it with a request-scoped `CorrelationContext` provider. Document the location.

## Carryover produced

- `IAuditLogPublisher` / `IAuditLogEvent` / `AUDIT_LOG_PUBLISHER` exported from `libs/contracts/auth/`.
- `NoOpAuditLogPublisher` bound to `AUDIT_LOG_PUBLISHER` in the auth module.
- Every audit-relevant use case calls the publisher at the documented event points.
- Doc `06-audit-log-publisher-port-skeleton.md`.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes — all use-case spec files assert `publish` calls.
- [ ] `yarn test:e2e` passes — the existing flows still pass (no behaviour change at the HTTP surface).
- [ ] `grep -rn "AUDIT_LOG_PUBLISHER" apps/api-gateway/src/` lists every audit-relevant use case as a consumer.
- [ ] `LOG_LEVEL=debug yarn start:dev:api-gateway` followed by a login produces a Pino line with context `AuditLog` and message `UserLoggedIn`.
- [ ] Doc `06-audit-log-publisher-port-skeleton.md` exists.
- [ ] No file outside `tmp/` references `tmp/`.
