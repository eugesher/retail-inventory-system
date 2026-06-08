# Auto-initializing a stock level when a variant is created

This document describes the first cross-service event consumer in the inventory
microservice beyond the notification fan-out: when the catalog publishes
`catalog.variant.created`, inventory creates a zeroed
[`StockLevel`](03-stocklevel-aggregate-and-version-column.md) row for the new
variant at the `default-warehouse`
[location](02-default-stocklocation-auto-provision.md). It covers the consumer
itself, the cross-service **delivery topology** (why the catalog publisher emits
onto `inventory_queue`), the idempotency strategy, what happens if the consumer
is offline when a variant is created, and the reserved
`inventory.stock-level.initialized` event the consumer emits.

The effect is observable through the
[availability read path](07-availability-read-path.md): straight after a variant
is created, `GET /api/inventory/variants/:variantId/stock` returns one
`default-warehouse` entry with `quantityOnHand: 0` and `available: 0`.

## Why auto-init exists

The variant is the downstream backbone key
([ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)):
inventory, pricing, and order lines all address the catalog `variantId`. A variant
with no `stock_level` row is not wrong — the read path treats a missing row as
"zero available everywhere" — but materializing the zeroed row at create time
means:

- The availability read returns a concrete per-location figure (not just an empty
  `locations: []`) from the moment a variant exists.
- The later Receive/Adjust write operations have a row to update on their common
  path, rather than every write needing a create-or-update branch.

So the inventory side reacts to the catalog's "a variant now exists" signal and
provisions the running-totals row eagerly.

## The consumer and its use case

The consumer is a thin RMQ subscriber, exactly the shape the notification
microservice established
([ADR-011](../../adr/011-notifier-port-and-adapters.md) §4): it lives under
`infrastructure/consumers/`, not `presentation/` (which is HTTP), and does nothing
but translate the wire payload into a use-case call.

`apps/inventory-microservice/src/modules/stock/infrastructure/consumers/catalog-events.consumer.ts`:

```ts
@Controller()
export class CatalogEventsConsumer {
  @EventPattern(ROUTING_KEYS.CATALOG_VARIANT_CREATED)
  public async onVariantCreated(@Payload() event: ICatalogVariantCreatedEvent): Promise<void> {
    this.logger.info(
      { correlationId: event.correlationId, variantId: event.variantId, sku: event.sku },
      'Consuming catalog.variant.created',
    );
    await this.autoInitStockLevel.execute(event);
  }
}
```

`correlationId` is logged **inline**, not via `PinoLogger.assign()`: an
`@EventPattern` handler is not request-scoped, and `assign()` throws outside a
request scope (ADR-011 §7).

`AutoInitStockLevelUseCase` is transport-free
([ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md) /
[ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)) — it knows
nothing about RabbitMQ. Given a `catalog.variant.created` event it:

1. Looks up `findStockLevel(variantId, 'default-warehouse')`.
2. If a row already exists → **no-op** (no save, no event).
3. If absent → saves `StockLevel.initialAt(variantId, 'default-warehouse')`
   (zeroed: `quantityOnHand`/`quantityAllocated`/`quantityReserved` all `0`,
   `version` `0`) and emits `inventory.stock-level.initialized`.

The default location id is the cross-service constant
`INVENTORY_DEFAULT_STOCK_LOCATION` (`'default-warehouse'`), the same row the
migration auto-provisions — never a string literal at the call site.

## Cross-service delivery topology

A NestJS RabbitMQ microservice consumes **exactly one queue** and dispatches
incoming messages by the `pattern` field in the envelope. Two services consuming
the same queue would compete and round-robin, so for inventory to receive
`catalog.variant.created`, that event must land on **`inventory_queue`** (the
queue inventory listens on), not `catalog_queue`.

The established pattern
([ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md) /
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)) is **the producer
emits onto the consumer's queue using that consumer's client token**. The
inventory microservice already does this in the other direction:
`inventory.stock.low` is emitted through the *notification* client so it lands on
`notification_events`. Auto-init applies the same rule:

- `CatalogRabbitmqPublisher.publishVariantCreated` emits
  `catalog.variant.created` through the `INVENTORY_MICROSERVICE` client → the
  event lands on `inventory_queue`, where `CatalogEventsConsumer` picks it up.
- The catalog Nest module imports `MicroserviceClientInventoryModule` so that
  client is injectable in the catalog process.
- `publishProductPublished` / `publishProductArchived` stay on the
  `CATALOG_MICROSERVICE` client (→ `catalog_queue`) as reserved surfaces — no
  consumer is bound to them yet.

```
catalog write (AddVariantUseCase)
        │  publishVariantCreated(...)
        ▼
CatalogRabbitmqPublisher ──emit via INVENTORY_MICROSERVICE──▶ inventory_queue
                                                                   │
                                                                   ▼
                                              CatalogEventsConsumer @EventPattern
                                                                   │
                                                                   ▼
                                                   AutoInitStockLevelUseCase
```

### Why not a topic/fanout exchange

Fanning one emit out to both `catalog_queue` and `inventory_queue` via a
topic/fanout exchange was **not** introduced. Every queue in the system binds the
**default exchange** today (ADR-008 / ADR-020); introducing a topic/fanout
exchange would contradict that "default exchange only" stance and would require a
superseding ADR. The producer-targets-consumer-queue pattern delivers the event
to the one consumer that needs it without any exchange topology change, so this
work **applies** ADR-008 / ADR-020 rather than deciding anything new — **no new
ADR**. If a future capability needs true pub/sub fan-out of catalog events to
several independent consumers, that is the moment to write that ADR.

## Idempotency: find-or-create plus a UNIQUE backstop

Events are at-least-once: a broker redelivery, or two near-simultaneous creates,
must not produce a duplicate row or a duplicate `initialized` event. The use case
is idempotent in two layers:

1. **Fast path — check then act.** `findStockLevel(...)` short-circuits to a
   no-op when the row already exists. This handles the common redelivery case
   without touching the write path.
2. **Backstop — the UNIQUE constraint.** If two events race past the find and both
   try to insert, the `stock_level` `UNIQUE (variant_id, stock_location_id)`
   constraint rejects the loser's INSERT. The use case catches that
   duplicate-key driver error (`ER_DUP_ENTRY` / errno `1062`) and treats it as the
   already-exists no-op — same outcome as the fast path.

Because the application layer must not import `typeorm`
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md) denylist),
the duplicate-key error is **duck-typed** on its `driverError` shape rather than
matched against `QueryFailedError`. The constraint is the source of truth; the
error shape is the signal.

`inventory.stock-level.initialized` is emitted **only when a genuinely new row is
created** — never on either no-op path. A repeat event changes no state and
produces no event.

## If the consumer is offline at create time

The event is not lost if inventory is down when a variant is created:

- **Durable broker delivery.** `inventory_queue` is a durable queue and
  `catalog.variant.created` is a persistent message, so RabbitMQ holds it while
  inventory is offline and delivers it when the service restarts and resubscribes.
  The auto-init then runs as normal.
- **Lazy re-init on first write.** As a second safety net, the Receive/Adjust
  write operations
  ([06-receive-and-adjust-use-cases.md](06-receive-and-adjust-use-cases.md))
  lazy-initialize the `(variantId, default-warehouse)` row on the first stock
  write if it is still absent. So even a permanently-dropped event self-heals the
  moment stock is first received or adjusted for the variant.

Together these mean the zeroed row is not a hard dependency on the consumer having
run — it is an eager optimization with two fallbacks.

## The `inventory.stock-level.initialized` event

On a genuinely new row, the use case emits `inventory.stock-level.initialized`
through the `STOCK_EVENTS_PUBLISHER` port. The wire contract is
`IInventoryStockLevelInitializedEvent`
(`libs/contracts/inventory/events/`):

```ts
interface IInventoryStockLevelInitializedEvent extends ICorrelationPayload {
  variantId: number;
  stockLocationId: string;
  eventVersion: 'v1';
  occurredAt: string;
}
```

The in-process `StockLevelInitializedEvent` domain class is mapped to this plain
wire interface in the publisher — a `DomainEvent` subclass is never serialized
across services (ADR-011). The event is emitted through the
`INVENTORY_MICROSERVICE` client, so it lands on `inventory_queue` (the service's
own queue). It is a **reserved surface**: no consumer is bound to it yet — the
same posture the `catalog.*` events held before this work. A later audit or
projection capability can subscribe without any producer change.

`eventVersion` is pinned to `'v1'`; a breaking payload change ships as `'v2'` so a
future consumer branches on the version rather than guessing from the field set.

## How to verify

With the stack up, a fresh `migration:run` + `test:seed`, and the catalog +
inventory microservices and the gateway running:

```bash
# 1. Create a product and a variant over HTTP (admin bearer omitted for brevity).
#    Adding the variant emits catalog.variant.created onto inventory_queue.
curl -s -X POST http://localhost:3000/api/catalog/products \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Demo","slug":"demo-auto-init","description":"d"}'
curl -s -X POST http://localhost:3000/api/catalog/products/<productId>/variants \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"sku":"DEMO-AUTOINIT-1","optionValues":{"color":"black"}}'

# 2. Within seconds the inventory consumer has created the zeroed row — poll the
#    public read until the default-warehouse entry appears.
curl -s http://localhost:3000/api/inventory/variants/<newVariantId>/stock | jq
#   → totalOnHand 0, totalAvailable 0, one default-warehouse entry (0/0/0)
```

`test/inventory-auto-init.e2e-spec.ts` boots the catalog + inventory
microservices and the gateway, creates a variant over the catalog HTTP flow,
polls until the `stock_level` row exists, asserts the public read shows the zeroed
`default-warehouse` entry, and re-emits a synthetic duplicate
`catalog.variant.created` to prove the consumer does not duplicate the row.
```

