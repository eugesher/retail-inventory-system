# 06 — Catalog events

This document records the catalog write seam's **event side**: the routing-key
naming convention (command vs event), the three catalog wire-event payloads
(`catalog.variant.created`, `catalog.product.published`,
`catalog.product.archived`) and their per-type `v1` versioning, the publisher
port/adapter that emits them, and the model where the catalog service publishes
its own events back onto the queue it listens on.

It is the companion to
[05 — Catalog write use cases](./05-catalog-use-cases.md), which describes the
use cases that produce these events. The wiring rules it follows are
[ADR-008 (RabbitMQ via `libs/messaging`, dotted routing keys)](../../adr/008-rabbitmq-via-libs-messaging.md),
[ADR-020 (RabbitMQ as the inter-service bus)](../../adr/020-rabbitmq-as-inter-service-bus.md),
and [ADR-011 (wire events are plain interfaces, never `DomainEvent` subclasses)](../../adr/011-notifier-port-and-adapters.md).
The code lives under
`apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/`,
`libs/contracts/catalog/`, and `libs/messaging/`.

## 1. Routing keys — command vs event

The catalog write seam owns seven routing keys: four imperative RPC commands and
three past-tense events. The wire format is the dotted
`<service>.<aggregate>.<action>` convention every key follows (ADR-008):

| `ROUTING_KEYS` member | wire value | kind |
|---|---|---|
| `CATALOG_PRODUCT_REGISTER` | `catalog.product.register` | RPC command |
| `CATALOG_PRODUCT_PUBLISH` | `catalog.product.publish` | RPC command |
| `CATALOG_PRODUCT_ARCHIVE` | `catalog.product.archive` | RPC command |
| `CATALOG_VARIANT_CREATE` | `catalog.variant.create` | RPC command |
| `CATALOG_VARIANT_CREATED` | `catalog.variant.created` | event |
| `CATALOG_PRODUCT_PUBLISHED` | `catalog.product.published` | event |
| `CATALOG_PRODUCT_ARCHIVED` | `catalog.product.archived` | event |

The **command/event distinction is carried in the verb tense**. An imperative key
(`catalog.variant.create`, `catalog.product.publish`, `catalog.product.archive`)
is the RPC the gateway sends to ask the catalog service to *do* something; the
matching past-tense key (`catalog.variant.created`, `catalog.product.published`,
`catalog.product.archived`) is the event the catalog service emits **after** it
has done so. The two halves of each pair are deliberately **different keys** —
`catalog.product.publish` ≠ `catalog.product.published`,
`catalog.product.archive` ≠ `catalog.product.archived`: one is a request with a
single responder, the other is a notification any number of consumers may
subscribe to. (`catalog.product.register` is a command with no matching event —
registration records no domain event; see [05](./05-catalog-use-cases.md) §2.)

Each key is declared in two places that must agree value-for-value: the
`ROUTING_KEYS` constants in `@retail-inventory-system/messaging` (the surface new
callers use) and the `MicroserviceMessagePatternEnum` in
`@retail-inventory-system/contracts` (the back-compat enum). A contract spec
(`libs/messaging/spec/routing-keys.constants.spec.ts`) asserts the two are equal
for every key and that every value matches the dotted regex, so a drift fails CI
rather than silently routing a message to the wrong queue (ADR-008).

## 2. The wire-event payloads

Every catalog wire event is a plain TypeScript interface in
`libs/contracts/catalog/events/`, extending `ICorrelationPayload` (so it carries
the `correlationId` that threads logs/traces across services) and adding an
`occurredAt: string` (ISO-8601 — the wire is JSON, so a `Date` is serialized to a
string). A `DomainEvent` subclass is **never** put on the wire (ADR-011 /
ADR-025); the use case drains the in-process event with `pullDomainEvents()` and
maps it to one of these interfaces.

### `catalog.variant.created`

```ts
interface ICatalogVariantCreatedEvent extends ICorrelationPayload {
  productId: number;
  variantId: number;
  sku: string;
  eventVersion: 'v1';
  occurredAt: string; // ISO-8601
}
```

`variantId` is the **concrete, persisted id**. The in-process
`VariantCreatedEvent` the aggregate records has a `null` id (it is recorded before
the row exists); the use case re-reads the real id after commit and builds this
payload then (see [05](./05-catalog-use-cases.md) §3).

### `catalog.product.published`

```ts
interface ICatalogProductPublishedEvent extends ICorrelationPayload {
  productId: number;
  slug: string;
  variantIds: number[];
  publishedAt: string;  // ISO-8601
  eventVersion: 'v1';
  occurredAt: string;   // ISO-8601
}
```

Emitted after a product transitions `draft → active`. `variantIds` are the
concrete variant ids that are now part of the published product — the eventual
consumer (a later inventory capability that initialises a zero stock level per
variant) keys on the **variant**, not the product (ADR-025). `publishedAt` is the
business timestamp of the transition; `occurredAt` is the event-envelope
timestamp. They carry the same instant today (both are the drained
`ProductPublishedEvent.occurredAt`), kept as distinct fields so a future producer
can diverge them — e.g. a scheduled publish whose `publishedAt` is set ahead of
the emission `occurredAt` — without a breaking version bump.

### `catalog.product.archived`

```ts
interface ICatalogProductArchivedEvent extends ICorrelationPayload {
  productId: number;
  archivedAt: string; // ISO-8601
  eventVersion: 'v1';
  occurredAt: string; // ISO-8601
}
```

Emitted after a product transitions `active → archived` (the catalog's terminal
soft-delete). The payload is intentionally minimal — a consumer that needs the
product's details re-reads it by id (the row stays resolvable after archival;
see [05](./05-catalog-use-cases.md) §8). `archivedAt` mirrors `publishedAt`'s
business-vs-envelope split.

### Why `eventVersion: 'v1'` — versioned by event type from day one

Every payload pins an explicit `eventVersion` literal, and the version is **per
event type**, not a single catalog-wide number. A cross-service event is a
contract with consumers the producer does not control; when one event's shape has
to change in a breaking way (a renamed or removed field), the producer ships that
event's `'v2'` and consumers branch on the version rather than guessing from the
field set. Versioning per type means `catalog.product.published` can reach `'v2'`
without disturbing `catalog.variant.created`'s consumers — each event evolves on
its own cadence. Pinning `'v1'` on all three from day one makes the first breaking
change a visible, greppable bump rather than an ambiguous schema drift. (This is
the event-payload analogue of the per-aggregate cache-key schema-version segment
used elsewhere in the system — ADR-022.)

## 3. Publisher port + adapter

The use cases never touch RabbitMQ. They depend on a port; a single adapter holds
the `ClientProxy`. This is the same port/adapter discipline the gateway and the
other microservices use — `@nestjs/microservices` transport types are allowed
**only** inside `infrastructure/messaging/*-rabbitmq.publisher.ts`
([ADR-009](../../adr/009-port-adapter-at-the-gateway.md) / ADR-020).

- **Port** — `application/ports/catalog-events.publisher.port.ts` declares
  `ICatalogEventsPublisherPort` and the DI symbol `CATALOG_EVENTS_PUBLISHER`. It
  has one method per catalog write event:
  - `publishVariantCreated(event, correlationId?)`
  - `publishProductPublished(event, correlationId?)`
  - `publishProductArchived(event, correlationId?)`
- **Adapter** — `infrastructure/messaging/catalog-rabbitmq.publisher.ts`
  (`CatalogRabbitmqPublisher`) injects the catalog `ClientProxy` under the
  `CATALOG_MICROSERVICE` token and `emit`s each event onto its routing key,
  materialized with `firstValueFrom`. `ClientProxy.emit()` returns a cold
  Observable; `firstValueFrom` subscribes and waits for the broker ack, so the
  caller depends on a plain `Promise` (ADR-020).

The **wire event is built in the use case, not the adapter.** This diverges from
the retail `OrderRabbitmqPublisher` (which maps a domain event to its wire shape
inside the adapter) on purpose: ADR-025 places the `pullDomainEvents()` drain and
the wire mapping at the application layer. For `catalog.variant.created` that is
load-bearing — the concrete `variantId` is only known after persistence, and the
use case is the layer that re-reads it. The publish/archive events keep the same
shape for consistency: the use case drains the `ProductPublishedEvent` /
`ProductArchivedEvent` and constructs the versioned payload, leaving the adapter a
thin `emit`-only seam whose sole job is to hide the `ClientProxy`.

## 4. The client module — events ride `catalog_queue`

`libs/messaging/microservice-client-catalog.module.ts`
(`MicroserviceClientCatalogModule`) registers a `ClientProxy` bound to
`catalog_queue` under the `CATALOG_MICROSERVICE` token, mirroring the other
per-service client modules. The catalog microservice imports it to publish its
**own** events — the service both listens on `catalog_queue` (its
`@MessagePattern` handlers) and emits the three catalog events back onto it.

This is intentional. None of the three events has a cross-service consumer today:
the eventual consumer of `catalog.variant.created` (and, transitively, of the
`variantIds` in `catalog.product.published`) is a later inventory capability that
will initialise a zero stock level for each new variant. Emitting an event to a
queue with **no matching handler** is harmless and is exactly the reserved-surface
pattern the system already uses for `retail.order.confirmed` (published today, no
cross-service consumer). All queues bind to the default exchange
(ADR-008/ADR-020); no topic-exchange routing is wired.

## 5. The contracts surface

`libs/contracts/catalog/` mirrors the `inventory` and `retail` contract folders,
and is re-exported from the contracts barrel (`libs/contracts/index.ts`). It
holds:

- `interfaces/` — the command payloads `IRegisterProductPayload`,
  `ICreateVariantPayload`, `IPublishProductPayload`, and `IArchiveProductPayload`
  (all extend `ICorrelationPayload`). The publish/archive payloads carry just
  `{ productId, correlationId }` — the transition target is the product id.
- `dto/` — the RPC response views `ProductView` and `ProductVariantView`.
  `ProductView` gained optional `publishedAt` / `archivedAt` timestamps, set only
  by the operation that performs the matching transition (see
  [05](./05-catalog-use-cases.md) §8).
- `events/` — the three event interfaces above.

Everything here is framework-free transport shape (the view DTOs carry
`@nestjs/swagger` response decorators, the documented contracts exception —
ADR-017); both ends of every key import the same interface, so a drift fails
TypeScript on the producer and the consumer alike.

## 6. Verification

- `yarn test:unit` — the routing-keys spec asserts each catalog key equals its
  `MicroserviceMessagePatternEnum` mirror; the Add Variant spec asserts the
  emitted `catalog.variant.created` carries the persisted `variantId`; the Publish
  spec asserts `catalog.product.published` carries the right `variantIds`, slug,
  `eventVersion: 'v1'`, and `correlationId`; the Archive spec asserts
  `catalog.product.archived` carries the `productId` and the version/correlation
  envelope.
- `yarn lint` (`--max-warnings 0`) — the `ClientProxy` appears only in the
  publisher adapter; the use cases and controller stay transport-free.

## What this does not do

This seam **emits** all three catalog events; it adds **no consumer** — the
inventory side that auto-initialises a stock level for a new variant is owned by
later inventory work. The read path (the published-catalogue query surface) and
the API gateway HTTP surface that fronts these RPC commands are described in their
own documents as they land.
