# API gateway

This file covers `apps/api-gateway`: what a request passes through before and after the RPC it
fronts, how an upstream rejection becomes an HTTP error, the idempotency and `If-Match` headers at
the edge, paging and query rules that differ route by route, and the `auth` module — the one gateway
module with its own state. Paths below are relative to `apps/api-gateway/src/` unless they start at
the repository root. The route table and who may call each route are in
[`README.md` §6](../../README.md#6-http-api) and [§7](../../README.md#7-authentication-and-authorization).
The rationale lives in the ADRs:

- [ADR-009](../adr/009-port-adapter-at-the-gateway.md): one port and one adapter per fronted service.
- [ADR-010](../adr/010-jwt-rbac-at-the-gateway.md) and
  [ADR-024](../adr/024-rbac-v2-staffuser-customer-and-permissions.md): tokens, the guards, staff and
  customer subjects, the admin shells.
- [ADR-028](../adr/028-cart-order-payment-and-address-chain.md): the identity the gateway folds into
  every command, and the owner-check downstream.
- [ADR-036](../adr/036-idempotency-key-store-and-enforced-occ.md): `Idempotency-Key` and `If-Match`.
- [ADR-037](../adr/037-consent-record-and-tombstone-erasure.md): consent and erasure.
- [ADR-044](../adr/044-system-health-fan-out.md): the health fan-out.
- [ADR-047](../adr/047-staff-user-creation-over-http.md): staff creation under `iam:staff-create`.
- [ADR-017](../adr/017-architecture-lint-via-eslint-boundaries.md) §6: `ARCH-LINT-EX-02`, the `auth`
  barrel.

## Request pipeline

`main.ts` and `app/app.module.ts`.

- **`CorrelationMiddleware` runs on every route and takes `x-correlation-id` as sent.** An absent or
  empty header gets a fresh UUID; any other value is kept with no check on length or shape
  ([`shared-libraries.md`](shared-libraries.md#correlationmiddleware)). The event store stores the id
  in a `VARCHAR(64)` column, so a longer header loses every firehose and audit row of that request
  ([`event-store.md`](event-store.md#failure-modes)).
- **The global `ValidationPipe` rejects unknown properties.** It runs with `whitelist`,
  `forbidNonWhitelisted` and `transform`, so a body or query property that the DTO does not declare
  is a `400` (`property foo should not exist`), not silently dropped. Validation errors use Nest's
  default body: `message` is an array of strings and there is no `code`.
- **`@IsOptional()` lets `null` through.** A `null` skips every other validator on the property. The
  inventory sweep shows what that means downstream
  ([`inventory.md`](inventory.md#the-reservation-sweep)).
- **`@ValidateNested()` does nothing on a missing property.** `PlaceOrderRequestDto` therefore puts
  `@IsDefined()` on both address bundles; without it an empty body would pass the edge and fail only
  inside the place transaction (`modules/cart/presentation/dto/place-order.request.dto.ts`). The
  nested lists of the fulfillment, return and inspect bodies are guarded by `@ArrayNotEmpty()`, which
  a missing value also fails.
- **Three global guards, then two global exception filters.** The guards and their order are in
  [`README.md` §7](../../README.md#7-authentication-and-authorization). The filters:
  - `DuplicateKeyExceptionFilter` turns a `QueryFailedError` with MySQL errno `1062`
    (`ER_DUP_ENTRY`) into a `409` with Nest's default `Conflict` body and the message
    `Resource already exists`. Any other `QueryFailedError` stays a `500`. It covers the loser of a
    race that passed a `findByEmail` check first, as in `RegisterCustomerUseCase` and
    `RegisterStaffUserUseCase` (`app/filters/duplicate-key-exception.filter.ts`).
  - `OptimisticLockExceptionFilter` turns TypeORM's `OptimisticLockVersionMismatchError` into
    `409 { code: 'VERSION_MISMATCH', currentVersion }`, reading the version from the error message.
    **No gateway entity has a version column**, so it never fires today
    (`common/filters/optimistic-lock.exception-filter.ts`).
- **No business RPC has a timeout.** Every adapter awaits `firstValueFrom(client.send(...))` with no
  rxjs `timeout`, and `ClientRMQ` in `@nestjs/microservices` 11.1.19 sets none. A request to a
  service that is down waits for as long as the caller keeps the connection open. The health probe
  is the one exception: it is bounded by `HEALTH_PROBE_TIMEOUT_MS`
  (`modules/health/infrastructure/messaging/health-rabbitmq.adapter.ts`).

## Error forwarding

Every RPC-fronting use case ends with `throwRpcError(error)`
(`common/utils/throw-rpc-error.util.ts`, pinned by `common/spec/throw-rpc-error.util.spec.ts`). A
microservice rejection arrives as the plain object its `*RpcExceptionFilter` threw,
`{ statusCode, message, code, details? }`:

| Upstream rejection                                           | HTTP answer                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------ |
| `400`, `403`, `404` or `409`, with a `code`                  | that status, body `{ statusCode, message, code }` (+ `details`)    |
| any other status from `400` to `599`, with a `code`          | that status, same body — this is how `422` and a tagged `500` pass |
| `400`, `403`, `404` or `409`, without a `code`               | that status, Nest's default `{ statusCode, message, error }` body  |
| any other status without a `code`, or no `statusCode` at all | a bare `500`                                                       |

- `details` is forwarded only when it is an object; a string or a number is dropped, and the key is
  then absent from the body.
- A `message` that is not a string is dropped, and Nest supplies its default text.
- A transport failure has no `statusCode` (`Number(undefined)` is `NaN`), so it is a bare `500`.

**The gateway mints only three codes of its own:** `IDEMPOTENCY_KEY_REQUIRED` and
`IF_MATCH_INVALID` (below), and `VERSION_MISMATCH` from the filter above. Every other rejection the
gateway raises itself — in `auth`, `iam`, `customer-admin`, the audit trace route and the
`ValidationPipe` — is a plain Nest exception with no `code`, so a client can branch only on the
status and the message there.

## Idempotency and `If-Match` at the edge

The store behind the key is retail's; its semantics are in
[`README.md` §5](../../README.md#idempotency) and
[`retail-orders.md`](retail-orders.md#the-idempotency-store).

- **`@IdempotencyKey()` is on exactly the four idempotent writes:** place, capture, ship and issue
  refund. Node lower-cases header names, so the header's case does not matter. The value is trimmed.
  A missing or blank key is
  `400 { statusCode, message, code: 'IDEMPOTENCY_KEY_REQUIRED' }` before any RPC is sent. The length
  is not bounded here (`common/decorators/idempotency-key.decorator.ts`).
- **Fresh and replayed answers differ by route.** Place and issue refund answer `201` when fresh and
  `200` with `Idempotent-Replay: true` on a replay. They write the response through `@Res()`,
  because with `passthrough` Nest would set the route's default `201` again. Capture and ship answer
  `200` either way and only add the header on a replay
  (`modules/cart/presentation/cart.controller.ts`, `CartController.placeOrder`;
  `modules/orders/presentation/refunds.controller.ts`, `RefundsController.issueRefund`;
  `modules/orders/presentation/orders.controller.ts`).
- **`@IfMatch()` is on the three cart line writes only** (add, change quantity, remove). The header
  is optional. The parser trims it and removes one pair of surrounding double quotes. An empty result
  counts as no header. A value that `Number()` reads as a non-negative integer is accepted, so `3`,
  `"3"`, `3.0` and `1e3` all pass. Anything else is
  `400 { statusCode, message, code: 'IF_MATCH_INVALID' }`, including `*` and a weak tag such as
  `W/"3"` (`common/decorators/if-match.decorator.ts`). What a stale version does is in
  [`retail-cart.md`](retail-cart.md#writes-and-concurrency).

## Paging

`page` and `pageSize` are coerced from strings by `@Type(() => Number)` and must be integers `≥ 1`
on every route. The rest differs by route:

| Route                                          | Defaults `page` / `pageSize` set by  | `pageSize` above 100              |
| ---------------------------------------------- | ------------------------------------ | --------------------------------- |
| `GET /catalog/products`                        | catalog (`clampPageWindow`)          | clamped to 100 by catalog         |
| `GET /catalog/categories/:slug/products`       | the gateway DTO's field initializers | clamped to 100 by catalog         |
| `GET /orders`                                  | the gateway use case, and retail     | clamped to 100 by retail          |
| `GET /inventory/variants/:variantId/movements` | the gateway controller               | **`400`** — the DTO's `@Max(100)` |
| `GET /notifications/deliveries`                | the gateway controller               | **`400`** — the DTO's `@Max(100)` |
| `GET /audit/events`, `GET /audit/entries`      | the event store (`clampPageWindow`)  | clamped to 100 by the event store |

The movements read gets its ceiling at the gateway because the inventory use case clamps nothing
(`apps/inventory-microservice/src/modules/stock/application/use-cases/list-stock-movements.use-case.ts`).

## Query parameters and response bodies

- **`?locationIds` takes a comma list or a repeated parameter.** `?locationIds=a,b` and
  `?locationIds=a,b&locationIds=c` both become `['a', 'b', 'c']`. Each token is trimmed and an empty
  token dropped; an empty parameter means every location
  (`modules/inventory/presentation/dto/variant-stock-query.dto.ts`).
- **A `null` from the service is a `200` with an empty body**, not a JSON `null`: Nest's Express
  adapter sends nothing for a nil result. Two routes return one: the applicable-price read when no
  price is in effect, and the marketing send when no active marketing template resolves
  (`test/price-read-default-currency.e2e-spec.ts` pins the first).
- **A whitespace-only `/audit/trace/:correlationId` is a `400`.** An empty id would match every
  `domain_event` row stored with `correlation_id = ''`. Any other value is sent untrimmed
  (`modules/audit/presentation/audit.controller.ts`, `AuditController.traceByCorrelation`).

### Time bounds

`from` / `to` are validated with `@IsISO8601()` on the audit reads and on the movements read.

- **The audit DTOs reject an inverted window; the movements DTO does not.** `IsOnOrAfter('from')` on
  `to` fails when both bounds parse and `to` is earlier. It passes when either bound is absent or
  does not parse, so one bad value yields one error, from `@IsISO8601()`. A zone-less date-time is
  compared as UTC, as the event store will read it
  (`modules/audit/presentation/dto/is-on-or-after.validator.ts`). An inverted movements window is
  sent on and answers an empty page.
- **`@IsISO8601()` accepts forms that `Date.parse` cannot read.** A week date (`2026-W10`), an
  ordinal date (`2026-100`), the basic format (`20260601`, `20260601T000000Z`) and an hour-only time
  (`2026-06-01T00Z`) all pass the DTO. The event store's `parseInstant` and the inventory use case
  then drop the unreadable bound, so the window silently widens
  ([`event-store.md`](event-store.md#reads)).
- **`@IsISO8601()` also accepts a space instead of `T`.** `2026-06-01 00:00:00` has no zone and does
  not match the zone-less pattern (`T` is required), so the gateway comparison and the event store
  both read it in the host's local zone.
- **The movements read pins no zone at all.** The inventory use case calls `new Date(value)`, so a
  zone-less `2026-06-01T00:00:00` resolves in the inventory host's local zone
  (`ListStockMovementsUseCase.parseInstant`).

## `auth`

`modules/auth/` is the one gateway module with a `domain/` and tables of its own: `staff_user`,
`customer`, `role`, `permission`, the two join tables and `consent_record`.

### Subjects and tokens

- **Every authenticated request checks that its subject still exists.** `ValidateJwtSubjectUseCase`
  asks the staff table first — `status = 'active'`, and the entity's `@DeleteDateColumn` hides a
  soft-deleted row — then the customer table, where `active` and `guest` pass. Roles and permissions
  are not reloaded: they come from the token. So an erased customer is refused (`401 Account is no
longer active`) on its very next request, while a role edit waits for the next refresh
  (`modules/auth/application/use-cases/validate-jwt-subject.use-case.ts`).
- **`/auth/refresh` and `/auth/logout` serve both kinds.** They look the `sub` up among staff first
  and among customers second (`modules/auth/application/use-cases/resolve-auth-subject.ts`).
- **A guest session is a real `customer` row.** `CreateGuestSessionUseCase` inserts
  `status = 'guest'` with no password and the email `guest-<uuid>@guest.local`. That address
  satisfies the email invariant and the unique index, and is never deliverable. The row stores the
  refresh-token hash like a login does. The returned `customerId` is what the client later sends as
  `fromCustomerId` to claim the cart
  (`modules/auth/application/use-cases/create-guest-session.use-case.ts`).
- **`StaffUser` and `Customer` keep their hashes out of `toJSON`.** The password hash and the refresh
  token hash are left out, so neither reaches a log line or a response through `JSON.stringify`
  (`modules/auth/domain/staff-user.model.ts`, `modules/auth/domain/customer.model.ts`).

### What reaches the broker

- **The aggregates' domain events are never published.** `StaffUser` and `Customer` record events
  (registered, logged in, roles assigned or revoked), and nothing in the gateway calls
  `pullDomainEvents`. The audit trail comes from `AUDIT_LOG_PUBLISHER` (`audit.staff.action` on
  `ris.events`), and the two `customer.*` events from `CustomerEventsRabbitmqPublisher`. Both are
  best-effort and never fail the request.
- **A guest session writes no audit row.** `RolePermissionsReplaced` is written for a
  description-only patch too; its payload says which part changed (`descriptionUpdated`,
  `permissionsReplaced`).

The audit `action` values the gateway writes, which are what `?action=` matches. How `actorKind`
becomes the stored `actorType` is in [`wire-contracts.md`](wire-contracts.md#auditstaffaction): only
`staff` stays `staff-user`.

| `action`                                         | Written by                    | `actorId`           |
| ------------------------------------------------ | ----------------------------- | ------------------- |
| `UserLoggedIn` / `LoginFailed`                   | staff login                   | staff user / `null` |
| `CustomerLoggedIn` / `CustomerLoginFailed`       | customer login                | customer / `null`   |
| `RefreshTokenRotated`, `RefreshReuseDetected`    | refresh                       | the subject         |
| `RefreshFailed`                                  | refresh                       | `null`              |
| `LogoutPerformed`                                | logout                        | the subject         |
| `CustomerRegistered`                             | customer registration         | the new customer    |
| `StaffUserRegistered`                            | `POST /iam/staff`             | the staff caller    |
| `RoleCreated`, `RolePermissionsReplaced`         | `POST` / `PATCH /iam/roles`   | the staff caller    |
| `StaffUserRolesAssigned`, `StaffUserRoleRevoked` | `POST` / `DELETE` staff roles | the staff caller    |
| `CustomerErased`                                 | the admin erase               | the staff caller    |

### Roles

- **A role edit is one transaction.** The description and, when `permissionCodes` is present, the
  whole `role_permissions` set are saved together. Omitting `permissionCodes` leaves the join table
  alone; `[]` empties it. A patch with neither field is `400 No-op patch`
  (`modules/auth/infrastructure/persistence/role-typeorm.repository.ts`,
  `RoleTypeormRepository.update`; `modules/iam/application/use-cases/update-role.use-case.ts`).
- **A list of role names is resolved whole.** Staff creation and role assignment reject the request
  if any name is unknown, name only the unknown ones in the `400` message, and change nothing.
  Unknown permission codes on a role write are refused the same way
  (`modules/iam/application/use-cases/assert-permissions-exist.ts`).
- **Revoking a staff user's last role is a `409`.** The aggregate throws a plain `Error`, and
  `RevokeStaffRoleUseCase` recognises it by its message. A role name the user does not hold is a
  `404` (`modules/iam/application/use-cases/revoke-staff-role.use-case.ts`).

### Erasure

`POST /admin/customers/:id/erase` runs `EraseCustomerUseCase`
(`modules/auth/application/use-cases/erase-customer.use-case.ts`). What erasure preserves and why is
in [`README.md` §5](../../README.md#privacy-and-consent) and ADR-037. In order:

1. An unknown id is a `404`.
2. An already-`deleted` customer returns its tombstone. Nothing is written, audited or emitted, and
   `confirmEmail` is not checked.
3. `confirmEmail`, trimmed and lower-cased, must equal the stored email (stored lower-case), or the
   answer is a `400` and nothing is written. A guest's stored email is its synthetic
   `guest-<uuid>@guest.local`.
4. `CustomerErasureWriterAdapter.persistErasure` writes four things in one transaction
   (`modules/auth/infrastructure/persistence/customer-erasure-writer.adapter.ts`):
   - the `customer` row: the personal fields, the password hash and the refresh-token hash set to
     `NULL`, `status = 'deleted'` and `deleted_at` stamped (`Customer.erase`);
   - every `address` row with `owner_type = 'customer'` for that customer: all personal columns
     `NULL`, `country` kept. No code writes such a row today — every address is an order snapshot —
     so this update matches nothing;
   - every `active` `cart` of that customer: `status = 'abandoned'` and `version + 1`, so a
     concurrent cart write loses its compare-and-swap instead of reviving the cart. The cart table
     holds no personal data. This is the only writer of `abandoned`: `Cart.markAbandoned` has no
     caller;
   - the `consent_record` row is deleted, so a later consent read falls back to the defaults
     (marketing off). The foreign key's `ON DELETE CASCADE` never fires, because the customer row
     is never deleted.
5. After the commit, the `CustomerErased` audit row is published, then `customer.erased`. Both are
   best-effort.

**Erasure does not touch inventory.** The abandoned carts' reservations stay `active` until the
reservation sweep expires them.

## Admin shells and `ARCH-LINT-EX-02`

`modules/iam/` and `modules/customer-admin/` have no `domain/` and bind no repository or adapter of
their own. Each imports `AuthModule` and injects what it exports: the role and permission
repositories, `AUDIT_LOG_PUBLISHER`, `RegisterStaffUserUseCase`, `ReadConsentUseCase` and
`EraseCustomerUseCase`. `STAFF_USER_REPOSITORY` and `CUSTOMER_REPOSITORY` are bound inside the
`libs/auth` dynamic module, which `AuthModule` re-exports whole (`modules/auth/auth.module.ts`). The
TypeScript imports go through `modules/auth/index.ts`, the one barrel another module may import
(`ARCH-LINT-EX-02`, ADR-017 §6). The admin consent read reuses the customer's own use case with
`isStaff: true` (`modules/customer-admin/presentation/customer-admin.controller.ts`).

## Failure modes

- **A service with no consumer holds the HTTP request open.** There is no RPC timeout (see _Request
  pipeline_). `GET /api/health` shows which service is not answering.
- **An `x-correlation-id` longer than 64 characters** loses the request's event-store rows; the
  request itself succeeds.
- **A lost insert race is a `409` without a `code`** (`Resource already exists`), where the
  check-then-act path that won the race gives its own message.
- **An unreadable or space-separated time bound** widens the window or shifts it to the host's zone
  instead of failing (see _Time bounds_).
- **An erased customer's stock holds last until their TTL.** Nothing releases them at erase time.
