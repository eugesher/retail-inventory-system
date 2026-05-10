# ADR-008: RabbitMQ wiring via `libs/messaging` and dotted routing keys

- **Date**: 2026-05-10
- **Status**: Accepted

---

## Context

Pre-task-04 the RabbitMQ wiring lived in three places:

- `libs/common/config/microservice-client-configuration.ts` — async
  factory producing `RmqOptions` from `ConfigService`.
- `libs/common/modules/microservice-client-{retail,inventory}.module.ts`
  — Nest modules registering the configured client under a token
  enum.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`
  — `MicroserviceMessagePatternEnum` with snake_case values
  (`retail_order_create`, `inventory_product_stock_get`, …).

Wiring concerns (factories, modules, exchange identifiers) and
routing-key constants belong in a single library; ADR-004's
hexagonal target needs domain code to depend on a publisher port,
not on `@nestjs/microservices` types directly. The recommendation
calls out `libs/messaging` as the messaging bounded-library home.

This ADR records the structural decisions for that move and the
routing-key naming convention.

## Decision

### `libs/messaging` hosts all RabbitMQ wiring

| Export | Role |
|--------|------|
| `MicroserviceClientConfiguration` | Async factory producing `RmqOptions` from `ConfigService`. Same shape as before — relocated, not rewritten. |
| `MicroserviceClientRetailModule`, `MicroserviceClientInventoryModule` | Pre-wired Nest modules registering the retail/inventory clients under their `MicroserviceClientTokenEnum` tokens. |
| `MessagingModule` | Convenience aggregator that imports both client modules and re-exports them. |
| `RabbitmqClientFactory.create(configService, queue)` | Returns a one-off `ClientProxy` for a given queue. Use this in tests and bootstrap scripts that need a proxy without registering a Nest provider. |
| `ROUTING_KEYS` | Frozen `as const` object mirroring `MicroserviceMessagePatternEnum`. Idiomatic constants object for new callers; `MicroserviceMessagePatternEnum` remains for backwards compatibility. |
| `EXCHANGES` | Frozen `as const` object: `{ RETAIL: 'retail', INVENTORY: 'inventory', NOTIFICATION: 'notification' }`. RabbitMQ today uses one queue per service without explicit exchanges; the constants land here so future migration to topic-exchange routing has a home. |

`MicroserviceQueueEnum` and `MicroserviceClientTokenEnum` stay in
`libs/contracts/microservices` (their canonical home) and are
re-exported from `libs/messaging` for caller convenience.

### Wire-format routing keys: dotted, not snake_case

`MicroserviceMessagePatternEnum` previously held snake_case strings:

```
inventory_product_stock_get
inventory_order_confirm
retail_order_create
retail_order_confirm
retail_order_get
```

Renamed to dotted `<service>.<aggregate>.<action>`:

```
inventory.product-stock.get
inventory.order.confirm
retail.order.create
retail.order.confirm
retail.order.get
```

This matches AMQP routing-key conventions (dot-separated tokens) and
keeps the door open to topic-exchange routing in the future
(`inventory.*.get`, `retail.order.#`). The kebab-case
(`product-stock`) inside a token preserves the multi-word aggregate
name without colliding with the dot separator.

The rename is **wire-format breaking**: gateway and microservices
must agree on the value. We picked **Plan A** — flip both sides in
one PR — for two reasons:

1. The repository deploys all four apps together; there is no
   "gateway is on snake_case for a week, microservice on dotted"
   transitional window.
2. The integration test infrastructure is reset on every run
   (`yarn test:infra:reload`), so no in-flight messages survive
   across the cutover.

`MicroserviceMessagePatternEnum` keeps its identifier names and
flips its values; `ROUTING_KEYS` exposes the same strings. Callers
that imported the enum continue to compile; only the wire format
changed.

### Domain code depends on a publisher port (deferred)

Today the RabbitMQ `ClientProxy` is injected directly by services
that publish (e.g. `retail-microservice/.../order-confirm.service.ts`
sends `inventory.order.confirm` via a `ClientProxy` keyed on
`MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE`). Per ADR-004
the long-term shape is:

- Domain layer defines `IMessagePublisher` (or similar).
- An adapter in `libs/messaging` (or app-side) implements it via
  `ClientProxy`.
- Domain code never imports `@nestjs/microservices`.

That port lands in task-08/task-09 when the per-service hexagonal
re-organisation runs. Task-04 deliberately stops at relocating the
existing wiring; introducing a publisher port in the same task
would conflate "structural move" with "API change" and balloon the
diff.

## Consequences

- **+** All RabbitMQ wiring is grouped, makes the eventual
  publisher-port introduction mechanical.
- **+** Routing keys follow AMQP convention; future topic-exchange
  routing has a clean migration path.
- **+** New callers reach for `ROUTING_KEYS` (idiomatic constants);
  existing callers using `MicroserviceMessagePatternEnum` keep
  working.
- **−** Wire-format break requires gateway and every microservice
  to ship together. Acceptable given the all-in-one deploy.
- **−** No publisher port today. Domain code in retail/inventory
  still imports `@nestjs/microservices`. Tracked for task-08/09.

## Alternatives considered

- **Plan B: keep snake_case routing keys.** Rejected: leaves the
  routing-key strings inconsistent with AMQP conventions, and
  forecloses the topic-exchange migration. The migration is the
  cheapest moment to fix the names — all consumers ship together.
- **Move only the modules, leave routing keys in
  `libs/contracts`.** Rejected: a constants object plus an enum
  with the same values is what bound the move into a library
  decision, not an enum-only concern. Co-locating constants with
  the wiring code that consumes them keeps the mental model
  simpler.
- **Introduce the publisher port now.** Rejected: scope creep.
  Better as a focused step in task-08/task-09 alongside the
  hexagonal re-org of the consuming services.
