# The notifications HTTP API at the gateway

The notification microservice has no HTTP surface of its own — it is RMQ-only
([ADR-011](../../adr/011-notifier-port-and-adapters.md)). Its
[template authoring](01-notification-template-versioning.md) and
[delivery audit](02-notification-delivery-as-audit-trail.md) RPCs become reachable
to an operator only when the API gateway fronts them over HTTP. This document
describes that gateway surface: a new `modules/notifications/` proxy that fronts six
of the notification RPCs at `/api/notifications`, and the `http/notifications.http`
file that exercises them.

The module honors [ADR-009](../../adr/009-port-adapter-at-the-gateway.md) (the
gateway port→adapter split — `ClientProxy` only inside the messaging adapter; modules
named after the downstream service, not the URL prefix) and
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) /
[ADR-010](../../adr/010-jwt-rbac-at-the-gateway.md) (`@RequiresPermission` is the
default route gate; every route here is staff-only).

## 1. The six routes

The gateway fronts the template authoring trio + the delivery `list`/`get`/`retry`
reads — six of the notification service's seven non-health RPCs. Each route is a thin
pass-through to a single RPC; the notification microservice owns all the logic
(version derivation, the channel-specific subject rule, paging/filtering, the
retryable-status guard).

| Method | Path | Permission | RPC | Returns |
|---|---|---|---|---|
| `GET` | `/api/notifications/templates` | `notifications:write` | `notification.template.list` | `NotificationTemplateView[]` |
| `POST` | `/api/notifications/templates` | `notifications:write` | `notification.template.author` | `NotificationTemplateView` (201) |
| `PATCH` | `/api/notifications/templates/:id/active` | `notifications:write` | `notification.template.set-active` | `NotificationTemplateView` |
| `GET` | `/api/notifications/deliveries` | `notifications:read` | `notification.delivery.list` | `IPage<NotificationDeliveryView>` |
| `GET` | `/api/notifications/deliveries/:id` | `notifications:read` | `notification.delivery.get` | `NotificationDeliveryView` |
| `POST` | `/api/notifications/deliveries/:id/retry` | `notifications:write` | `notification.delivery.retry` | `NotificationDeliveryView` |

Notes on each:

- **List / author / activate templates** front the authoring surface. `POST` has
  create-or-edit semantics keyed on `(eventType, channel, locale)` — the service
  appends a fresh `active` version, retaining the prior ones (the
  [versioned registry](01-notification-template-versioning.md)). `PATCH .../active` is
  the **rollback lever**: deactivating the newest version makes "find latest active"
  fall through to the prior one. A subject-less `email`/`webhook` author is a `400`;
  a duplicate version a `409`; an unknown id on activate a `404` — all surfaced from
  the notification domain's RPC exception filter through the gateway's
  `throwRpcError`, which forwards the typed `code` so a client can branch on it.
- **List / get deliveries** front the [audit trail](02-notification-delivery-as-audit-trail.md).
  The list is paginated and newest-first with optional `customerId` /
  `eventReferenceType` / `eventReferenceId` / `status` filters; `get` is the
  single-row drill-down (including the materialized `renderedBody`).
- **Retry a delivery** fronts the operator [manual retry](06-retry-and-failure-events.md):
  it re-dispatches one **`failed`** delivery's already-rendered content, forcing past
  the scheduled sweeper's backoff. A non-`failed` source is a `409`, an unknown id a
  `404`.

### Why `notifications:write` gates the template *list*

The template list is a read, yet it is gated by `notifications:write` rather than
`notifications:read`. This is deliberate: the template registry is a **write-side
admin tool** — an operator lists templates to decide which to edit or roll back, so
the capability travels with authoring. `notifications:read` is reserved for the
**delivery audit** surface, which a read-only support role might hold without the
ability to change templates. The two codes thus cleave the surface along
authoring-vs-observability lines, not GET-vs-mutation lines.

## 2. Staff-only, no owner-check

Every route carries an explicit `@RequiresPermission(...)`. None has an owner-check,
and that is the correct shape here.

Some gateway surfaces (orders, returns, refunds) are **owner-or-staff**: a customer
may read or act on *their own* resource, and a staff permission is an override. Those
routes carry **no** `@RequiresPermission` (it would block the owning customer) and
push the owner-check down into the retail use case.

The notifications surface is different — it is **admin/ops only**. Templates are
global configuration; the delivery trail is operational audit data; manual retry is
an operator action. There is no "customer's own notification" to scope to. So the
simpler, correct shape applies: gate every route with `@RequiresPermission`
directly. Because customer tokens carry no `permissions` claim (only staff tokens are
permission-inflated at login/refresh — see
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)), a code-gated route is
staff-only by construction; no extra guard or owner-check is needed.

`notifications:read` and `notifications:write` were seeded and bound to the `admin`
role in the capability's first slice; this is the first set of HTTP endpoints those
codes gate.

## 3. The record-outcome RPC has no gateway route

The notification service exposes a seventh non-health RPC,
`notification.delivery.record-outcome` — the seam an ESP (email service provider)
webhook would call to mark a `sent` delivery `delivered` or `bounced`. It is
**intentionally not fronted here.**

That RPC is the [documented stub](02-notification-delivery-as-audit-trail.md) for a
real webhook bridge: a production ESP integration needs an HTTP endpoint with
provider-specific signature verification and payload mapping — not a generic
JSON-body proxy like the other routes. Exposing it as a plain authenticated POST
would invite a caller to forge delivery outcomes. So it stays RMQ-only until a
purpose-built webhook-ingestion capability lands; the gateway module's port
deliberately omits a `recordOutcome` method, and the controller has no
`deliveries/:id/outcome` route.

## 4. Module shape

The module mirrors the gateway's other DB-free proxy, `modules/inventory/`
(port + adapter + thin use cases + controller + DTOs, no `domain/`):

```
apps/api-gateway/src/modules/notifications/
  application/
    ports/notifications-gateway.port.ts   # NOTIFICATIONS_GATEWAY_PORT + INotificationsGatewayPort
    use-cases/                             # one thin use case per route (6)
  infrastructure/
    messaging/notifications-rabbitmq.adapter.ts   # the SOLE ClientProxy holder
  presentation/
    notifications.controller.ts            # the six routes
    dto/                                   # request body + query DTOs
  notifications.module.ts
```

- **`NotificationsRabbitmqAdapter`** is the only holder of a `ClientProxy` (over the
  `NOTIFICATION_MICROSERVICE` client). It is the only file in the module that imports
  `@nestjs/microservices`; the controller and use cases depend on
  `NOTIFICATIONS_GATEWAY_PORT` (ADR-009).
- **The `correlationId` split.** The port's command/query interfaces are
  *business-shaped* — they omit `correlationId`, which is a transport concern. The
  controller reads it once via `@CorrelationId()` and passes it as a separate
  argument; the adapter stitches it onto the wire payload (`{ ...command,
  correlationId }`). This mirrors the inventory adapter and keeps the controller and
  use cases ignorant of the wire-payload shape.
- **Thin use cases.** Each use case logs the `correlationId` (via
  `logger.assign(...)` — valid here because gateway use cases run inside an HTTP
  request scope, unlike a microservice's `@MessagePattern` handler, where
  [ADR-001](../../adr/001-structured-logging-with-pino.md) §7 requires inline
  fields), calls the port, and maps any downstream rejection onto the right HTTP
  status with `throwRpcError`. They carry no business logic.
- **Edge defaulting in DTOs.** `AuthorTemplateRequestDto` defaults `locale` to
  `en-US` at the edge (the property initializer); `DeliveriesQueryDto` defaults
  `page`→1 / `pageSize`→20 (ceiling `@Max(100)`) at the controller. The wire payload's
  page-length field is itself `pageSize`, so — unlike the inventory movements read —
  no rename to `size` is needed.

The module is registered in `apps/api-gateway/src/app/app.module.ts` alongside the
other gateway modules.

## 5. The `http/notifications.http` flow

[`http/notifications.http`](../../../http/notifications.http) documents all six routes
as runnable [Kulala](https://github.com/mistweaverco/kulala.nvim) requests, following
the conventions of the sibling `.http` files. The happy-path flow it captures:

1. **`login`** — a seeded staff login (`admin@example.com`, which holds both
   `notifications:read` and `notifications:write`). The response's `accessToken` is
   captured into `@accessToken` and sent as the bearer on every protected call.
2. **`authorTemplate`** — author a `retail.order.placed` / `email` / `en-US`
   template; its `id` is captured into `@templateId`.
3. **`listTemplates`** — browse the registry (scoped to that event) so the new
   version appears.
4. **`setTemplateActiveDeactivate` / `setTemplateActiveReactivate`** — flip the
   captured template's active flag off then on (the rollback lever).
5. **`listDeliveries` / `listDeliveriesFailed`** — query the delivery audit trail
   (by reference type, then by `failed` status).
6. **`getDelivery` / `retryDelivery`** — drill into one delivery row and manually
   retry a `failed` one.

The file also includes the rejection cases (a subject-less email author → `400`, an
unknown template id → `404`, an unknown delivery id → `404`) so the typed error codes
are visible end-to-end.

One sequencing note the file documents: a **delivery row only exists once a producing
event has flowed against an active template** (a consumer writes the row — see the
[render-and-dispatch pipeline](03-render-and-dispatch-pipeline.md)). There is no
endpoint that mints a delivery. So the delivery reads return an empty page until an
order is placed (or another producing event fires); the file explains how to source a
real delivery id (from the list read, or the `notification_delivery` table) for the
`get`/`retry` calls. No new environment variable was needed — the requests reuse the
existing `ENV_BASE_URL` from `http/http-client.env.json`.
