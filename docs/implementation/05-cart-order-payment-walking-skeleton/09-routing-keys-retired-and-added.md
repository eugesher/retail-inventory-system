# 09 — Retail routing keys: retired vs added, and the notification re-point

Rebuilding the checkout context around a mutable `Cart` and an immutable `Order`
replaced the retail message surface wholesale. The old monolithic order RPCs were
removed and a new, finer-grained set of cart / order / payment keys took their place.
This document is the **old-vs-new routing-key map** — what each key is (an imperative
RPC command vs a past-tense event), which queue it travels on, and whether anything
consumes it — plus the one consumer that was **re-pointed** so the order notification
leg survived the rebuild.

Routing keys are the dotted `<service>.<aggregate>.<action>` constants in
[`libs/messaging/routing-keys.constants.ts`](../../../libs/messaging/routing-keys.constants.ts),
mirrored value-for-value in `MicroserviceMessagePatternEnum`
([ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md)). Every queue binds the
default exchange today, so an **event producer publishes onto the consumer's queue**,
not its own — the producer-targets-consumer-queue pattern.

## Retired — the six legacy `retail.order.*` keys

The previous order model exposed one coarse RPC surface plus three lifecycle events.
All six were deleted outright when the legacy order tables were dropped (the cleanup
removes, never renames — [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)):

| Retired key | Was | Notes |
|---|---|---|
| `retail.order.create` | RPC | Created an order directly from a request body — superseded by the cart → place flow. |
| `retail.order.confirm` | RPC | Cross-service stock-confirm on confirm; the whole confirm seam moved to a future inventory-reservation capability. |
| `retail.order.get` | RPC | Single-order read — **re-introduced** below with owner-or-staff authorization (a name reused, a different contract). |
| `retail.order.created` | event | Order-created fan-out to notification — **re-pointed** to `retail.order.placed` (see below). |
| `retail.order.confirmed` | event | Reserved lifecycle event; no producer/consumer survived the rebuild. |
| `retail.order.cancelled` | event | Reserved lifecycle event; the rebuilt `Order` has no cancel mutator yet. |

## Added — the cart / order / payment surface

The rebuilt checkout splits the work across the **cart** context (mutable, command +
reserved-event keys) and the **orders** context (immutable order + payment). The Place
Order key is a cart key by name (it acts on the cart) but is served by the orders
controller, since placement produces an `Order`.

### RPC command keys (API Gateway → Retail, served on `retail_queue`)

| Key | Kind | Handler | Resolves |
|---|---|---|---|
| `retail.cart.create` | RPC | cart controller | `CartView` |
| `retail.cart.get` | RPC | cart controller | `CartView` (owner-checked) |
| `retail.cart.add-line` | RPC | cart controller | `CartView` (snapshots price; unpriced variant → 409) |
| `retail.cart.change-line-quantity` | RPC | cart controller | `CartView` (`0` rejected) |
| `retail.cart.remove-line` | RPC | cart controller | `CartView` |
| `retail.cart.claim` | RPC | cart controller | `CartView` (guest-cart promotion) |
| `retail.cart.place` | RPC | **orders** controller | `OrderView` (convert cart → order, authorize-on-place) |
| `retail.order.get` | RPC | orders controller | `OrderView` (owner or staff `order:read`) |
| `retail.order.list` | RPC | orders controller | `IPage<OrderView>` (own-only, newest-first) |
| `retail.payment.capture` | RPC | orders controller | `OrderView` (owner or staff `order:capture`) |

### Event keys

| Key | Kind | Queue | Consumer |
|---|---|---|---|
| `retail.cart.created` | event | `retail_queue` | none (reserved surface) |
| `retail.cart.line-added` | event | `retail_queue` | none (reserved surface) |
| `retail.cart.line-removed` | event | `retail_queue` | none (reserved surface) |
| `retail.cart.line-quantity-changed` | event | `retail_queue` | none (reserved surface) |
| **`retail.order.placed`** | event | **`notification_events`** | **`OrderEventsConsumer`** (active) |
| `retail.payment.authorized` | event | `retail_queue` | none (reserved surface) |
| `retail.payment.captured` | event | `retail_queue` | none (reserved surface) |

`retail.order.placed` is the only retail event with a live consumer. It is emitted
onto `notification_events` — the notification microservice's queue — because the
default-exchange topology requires the producer to target the consumer's queue
directly. The four `retail.cart.*` and two `retail.payment.*` events sit on the retail
service's own `retail_queue` with no binding yet; they are wired so a future audit or
fulfillment consumer is purely additive.

## The consumer re-point — `retail.order.created` → `retail.order.placed`

The notification microservice is the canonical per-module template
([ADR-011](../../adr/011-notifier-port-and-adapters.md)): RMQ subscribers live under
`infrastructure/consumers/`, each a thin adapter that translates a wire event into a
use case, and each logs the `correlationId` inline (`PinoLogger.assign()` throws
outside request scope). Tearing down the legacy order model deleted the
`retail.order.created` consumer and its send use case; this capability re-creates both
against the new event so the order-notification leg is whole again — done inline, not
deferred to a separate notification capability.

The re-point is a clean re-create, not a rename, because the payload changed shape:

- **Old `IRetailOrderCreatedEvent`** carried `status` + a `products[]` array — a
  consumer had to understand order line structure.
- **New
  [`IRetailOrderPlacedEvent`](../../../libs/contracts/retail/events/order-placed.event.ts)**
  is a thin header: `orderId` / `orderNumber` identify the order, `grandTotalMinor` /
  `currency` / `lineCount` summarize it, `customerId` is the gateway customer UUID or
  `null` (a tombstoned order). A consumer that needs line detail reads the order back.
  `eventVersion` is pinned `'v1'`; `occurredAt` is ISO-8601.

The rebuilt leg is two files plus their registration:

- **`SendOrderNotificationUseCase`** consumes `IRetailOrderPlacedEvent`, builds a
  `Notification` (`channel: LOG`, `recipient: 'order:<orderId>'`, subject/body citing
  `orderNumber` + `grandTotalMinor` + `currency` + `lineCount`, `metadata` carrying the
  event fields + `occurredAt`), logs the `correlationId`, and dispatches via the
  `NOTIFIER` port (default `LogNotifierAdapter`).
- **`OrderEventsConsumer`** binds `@EventPattern(ROUTING_KEYS.RETAIL_ORDER_PLACED)` →
  `SendOrderNotificationUseCase.execute(event)`.

Both are registered in `notifications.module.ts` alongside the untouched low-stock
consumer. The full path — gateway → retail Place Order → `retail.order.placed` →
notification fan-out — is the same `retail.order.placed` emit the place use case
performs best-effort post-commit; the notification microservice now picks it up.

## Related documents

- [01 — Retail rebuild, old tables dropped](01-retail-rebuild-and-old-tables-dropped.md) — where the six keys were retired.
- [07 — Authorize on place, capture explicit](07-authorize-on-place-capture-explicit-q5.md) — the producer of `retail.order.placed`.
- [ADR-008 — RabbitMQ wiring and dotted routing keys](../../adr/008-rabbitmq-via-libs-messaging.md).
- [ADR-011 — `NotifierPort` and the notification microservice template](../../adr/011-notifier-port-and-adapters.md).
- [ADR-028 — Cart / Order / Payment / Address chain](../../adr/028-cart-order-payment-and-address-chain.md).
