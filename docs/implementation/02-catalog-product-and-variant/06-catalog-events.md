# 06 — Catalog events

This document records the catalog write seam's **event side**: the routing-key
naming convention (command vs event), the `catalog.variant.created` wire payload
and its `v1` versioning, the publisher port/adapter that emits it, and the model
where the catalog service publishes its own events back onto the queue it
listens on.

It is the companion to
[05 — Catalog write use cases](./05-catalog-use-cases.md), which describes the
use case that produces the event. The wiring rules it follows are
[ADR-008 (RabbitMQ via `libs/messaging`, dotted routing keys)](../../adr/008-rabbitmq-via-libs-messaging.md),
[ADR-020 (RabbitMQ as the inter-service bus)](../../adr/020-rabbitmq-as-inter-service-bus.md),
and [ADR-011 (wire events are plain interfaces, never `DomainEvent` subclasses)](../../adr/011-notifier-port-and-adapters.md).
The code lives under
`apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/`,
`libs/contracts/catalog/`, and `libs/messaging/`.

## 1. Routing keys — command vs event

The catalog write seam adds three routing keys. The wire format is the dotted
`<service>.<aggregate>.<action>` convention every key follows (ADR-008):

| `ROUTING_KEYS` member | wire value | kind |
|---|---|---|
| `CATALOG_PRODUCT_REGISTER` | `catalog.product.register` | RPC command |
| `CATALOG_VARIANT_CREATE` | `catalog.variant.create` | RPC command |
| `CATALOG_VARIANT_CREATED` | `catalog.variant.created` | event |

The **command/event distinction is carried in the verb tense**:
`catalog.variant.create` (imperative — "do this") is the RPC the gateway sends to
ask the catalog service to add a variant; `catalog.variant.created` (past tense —
"this happened") is the event the catalog service emits **after** it has done so.
They are deliberately **different keys**: one is a request with a single
responder, the other is a notification any number of consumers may subscribe to.

Each key is declared in two places that must agree value-for-value: the
`ROUTING_KEYS` constants in `@retail-inventory-system/messaging` (the surface new
callers use) and the `MicroserviceMessagePatternEnum` in
`@retail-inventory-system/contracts` (the back-compat enum). A contract spec
(`libs/messaging/spec/routing-keys.constants.spec.ts`) asserts the two are equal
for every key and that every value matches the dotted regex, so a drift fails CI
rather than silently routing a message to the wrong queue (ADR-008).

## 2. The `catalog.variant.created` payload

The wire event is a plain TypeScript interface in
`libs/contracts/catalog/events/`:

```ts
interface ICatalogVariantCreatedEvent extends ICorrelationPayload {
  productId: number;
  variantId: number;
  sku: string;
  eventVersion: 'v1';
  occurredAt: string; // ISO-8601
}
```

- It extends `ICorrelationPayload`, so it carries the `correlationId` that
  threads logs and traces across services.
- `occurredAt` is an ISO-8601 **string**, not a `Date` — the wire is JSON.
- `variantId` is the **concrete, persisted id**. The in-process
  `VariantCreatedEvent` the aggregate records has a `null` id (it is recorded
  before the row exists); the use case re-reads the real id after commit and
  builds this payload then (see [05](./05-catalog-use-cases.md)).

### Why `eventVersion: 'v1'`

The payload pins an explicit `eventVersion` literal. A cross-service event is a
contract with consumers the producer does not control; when the shape has to
change in a breaking way (a renamed or removed field), the producer ships
`'v2'` and consumers branch on the version rather than guessing from the field
set. Pinning `'v1'` from day one means the first breaking change is a visible,
greppable bump rather than an ambiguous schema drift. (This is the
event-payload analogue of the cache-key schema-version segment used elsewhere in
the system.)

## 3. Publisher port + adapter

The use case never touches RabbitMQ. It depends on a port; a single adapter holds
the `ClientProxy`. This is the same port/adapter discipline the gateway and the
other microservices use — `@nestjs/microservices` transport types are allowed
**only** inside `infrastructure/messaging/*-rabbitmq.publisher.ts`
([ADR-009](../../adr/009-port-adapter-at-the-gateway.md) / ADR-020).

- **Port** — `application/ports/catalog-events.publisher.port.ts` declares
  `ICatalogEventsPublisherPort` and the DI symbol `CATALOG_EVENTS_PUBLISHER`.
  Its one method today is `publishVariantCreated(event, correlationId?)`.
- **Adapter** — `infrastructure/messaging/catalog-rabbitmq.publisher.ts`
  (`CatalogRabbitmqPublisher`) injects the catalog `ClientProxy` under the
  `CATALOG_MICROSERVICE` token and calls
  `emit(ROUTING_KEYS.CATALOG_VARIANT_CREATED, event)`, materialized with
  `firstValueFrom`. `ClientProxy.emit()` returns a cold Observable;
  `firstValueFrom` subscribes and waits for the broker ack, so the caller depends
  on a plain `Promise` (ADR-020).

The **wire event is built in the use case, not the adapter.** This diverges from
the retail `OrderRabbitmqPublisher` (which maps a domain event to its wire shape
inside the adapter) on purpose: ADR-025 places the `pullDomainEvents()` drain and
the wire mapping at the application layer, because the concrete `variantId` is
only known after persistence and the use case is the layer that re-reads it. The
adapter is therefore thin — its sole job is to hide the `ClientProxy` behind the
port boundary.

## 4. The client module — events ride `catalog_queue`

`libs/messaging/microservice-client-catalog.module.ts`
(`MicroserviceClientCatalogModule`) registers a `ClientProxy` bound to
`catalog_queue` under the `CATALOG_MICROSERVICE` token, mirroring the other
per-service client modules. The catalog microservice imports it to publish its
**own** events — the service both listens on `catalog_queue` (its
`@MessagePattern` handlers) and emits `catalog.variant.created` back onto it.

This is intentional. The event's eventual consumer is a later inventory
capability that will initialise a zero stock level for each new variant; that
consumer does not exist yet. Emitting an event to a queue with **no matching
handler** is harmless and is exactly the reserved-surface pattern the system
already uses for `retail.order.confirmed` (published today, no cross-service
consumer). All queues bind to the default exchange (ADR-008/ADR-020); no
topic-exchange routing is wired.

## 5. The contracts surface

`libs/contracts/catalog/` is created mirroring the `inventory` and `retail`
contract folders, and is re-exported from the contracts barrel
(`libs/contracts/index.ts`). It holds:

- `interfaces/` — the command payloads `IRegisterProductPayload` and
  `ICreateVariantPayload` (both extend `ICorrelationPayload`).
- `dto/` — the RPC response views `ProductView` and `ProductVariantView`.
- `events/` — the `ICatalogVariantCreatedEvent` interface.

Everything here is framework-free transport shape (the view DTOs carry
`@nestjs/swagger` response decorators, the documented contracts exception —
ADR-017); both ends of every key import the same interface, so a drift fails
TypeScript on the producer and the consumer alike.

## 6. Verification

- `yarn test:unit` — the routing-keys spec asserts the three new keys equal
  their `MicroserviceMessagePatternEnum` mirror; the Add Variant use-case spec
  asserts the publisher port is called with a payload carrying the persisted
  `variantId`, the `sku`, `eventVersion: 'v1'`, and the `correlationId`.
- `yarn lint` (`--max-warnings 0`) — the `ClientProxy` appears only in the
  publisher adapter; the use case and controller stay transport-free.

## What this does not do

This seam **emits** `catalog.variant.created`; it adds **no consumer** — the
inventory side that auto-initialises a stock level for a new variant is owned by
later inventory work. The `catalog.product.published` / `catalog.product.archived`
events join this document when the Publish/Archive use cases land.
