---
epic: epic-04
task_number: 4
title: Auto-init StockLevel = 0 on catalog.variant.created
depends_on: [1, 2, 3]
doc_deliverable: docs/implementation/04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md
adr_deliverable: none
---

# Task 04 — Auto-init StockLevel = 0 on catalog.variant.created

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-011** (RMQ subscribers live under `infrastructure/consumers/`,
not `presentation/`; cross-service events are plain `ICorrelationPayload` wire
interfaces — never serialize a `DomainEvent` subclass; inside `@EventPattern`
handlers log `correlationId` **inline** — `PinoLogger.assign()` throws outside
request scope), **ADR-008 / ADR-020** (cross-service delivery: a producer emits
onto the **consumer's** queue using that consumer's client token; one queue per
service; default exchange only — do not introduce a topic/fanout exchange without
a new ADR), **ADR-004 / ADR-017** (consumer is a thin infrastructure adapter that
calls a use case; the use case stays transport-free).

## Goal

Wire the first cross-service event consumer beyond notification: when the catalog
publishes `catalog.variant.created`, the inventory microservice creates a
`StockLevel = 0` row for the new variant at `default-warehouse`. The consumer is
**idempotent** (a repeat event does not duplicate the row, thanks to the
`(variant_id, stock_location_id)` UNIQUE constraint) and emits
`inventory.stock-level.initialized` on a genuinely new row. Because the system
uses one queue per service over the default exchange, the catalog publisher is
retargeted to emit `catalog.variant.created` onto `inventory_queue` (the
consumer's queue) — the same producer-targets-consumer-queue pattern
`inventory.stock.low → notification_events` already uses.

## Entry state assumed

- task-01 → task-03 carryovers present. `stock_level` exists with the
  `(variant_id, stock_location_id)` UNIQUE constraint; `default-warehouse` is
  provisioned; `StockLevel.initialAt(...)` and
  `IStockRepositoryPort.saveStockLevel` / `findStockLevel` are on disk. The
  read path + gateway are live (so the consumer's effect is observable via
  `GET /api/inventory/variants/:id/stock`).
- The catalog microservice's `CatalogRabbitmqPublisher`
  (`apps/catalog-microservice/.../catalog/infrastructure/messaging/`) currently
  emits `catalog.variant.created` onto **`catalog_queue`** via the
  `CATALOG_MICROSERVICE` client (a reserved surface with no consumer). The wire
  contract `ICatalogVariantCreatedEvent` (`libs/contracts/catalog/events/`) already
  exists: `{ productId, variantId, sku, eventVersion: 'v1', occurredAt,
  correlationId }`.
- The inventory microservice listens on `inventory_queue` and already consumes
  nothing cross-service (it only serves its own RPCs). The notification service is
  the existing model: its `InventoryEventsConsumer` (`infrastructure/consumers/`)
  uses `@EventPattern` and a thin use case.

## Cross-service delivery decision (read before coding)

For inventory to receive `catalog.variant.created`, the event must land on
`inventory_queue` (a NestJS microservice consumes exactly one queue; two services
consuming the same queue would compete and round-robin). The established pattern
(ADR-008 / ADR-020) is **the producer emits onto the consumer's queue using that
consumer's client token** — exactly how the inventory publisher emits
`inventory.stock.low` onto `notification_events`. Apply it here:

- **Retarget** the catalog `CatalogRabbitmqPublisher.publishVariantCreated` to
  emit `catalog.variant.created` onto **`inventory_queue`** via the
  `INVENTORY_MICROSERVICE` client (inject it; import
  `MicroserviceClientInventoryModule` in the catalog module that provides the
  publisher). Leave `publishProductPublished` / `publishProductArchived` emitting
  onto `catalog_queue` as reserved surfaces (no consumer).
- This is **not** a new architectural decision — it applies ADR-008 / ADR-020, so
  **no new ADR** is required. Document the topology clearly in doc `05`.
- **Do NOT** introduce a topic/fanout exchange to fan one emit to both queues —
  that would contradict ADR-008 / ADR-020's "default exchange only" stance and
  would require a superseding ADR. If a future capability needs true pub/sub
  fan-out of catalog events to multiple consumers, that is the moment to write
  that ADR — not here.

## Idempotency + lazy re-init

- The consumer calls `AutoInitStockLevelUseCase`, which: looks up
  `findStockLevel(variantId, 'default-warehouse')`; if absent, saves
  `StockLevel.initialAt(variantId, 'default-warehouse')` and emits
  `inventory.stock-level.initialized`; if present, it is a no-op (no duplicate
  row, no event). The `(variant_id, stock_location_id)` UNIQUE constraint is the
  backstop if two events race — catch the unique-violation and treat it as the
  "already exists" no-op.
- **Consumer-down case:** if the consumer is offline when a variant is created,
  the broker holds the durable message and delivers it when inventory restarts.
  As a further safety net, the Receive/Adjust use cases (task-05) lazy-init the
  row on first write. Document both paths in doc `05`.

## New domain event + routing key

- Add a `StockLevelInitializedEvent` domain event
  (`apps/.../stock/domain/events/stock-level-initialized.event.ts`) — mirror the
  existing `stock-low.event.ts` style (a plain class carrying `variantId`,
  `stockLocationId`, `occurredAt`). Barrel it from `domain/events/index.ts`.
- Add the wire contract
  `libs/contracts/inventory/events/stock-level-initialized.event.ts`:
  `IInventoryStockLevelInitializedEvent extends ICorrelationPayload` with
  `{ variantId: number; stockLocationId: string; eventVersion: 'v1';
  occurredAt: string }`. Barrel from `libs/contracts/inventory/events/index.ts`.
- Add `INVENTORY_STOCK_LEVEL_INITIALIZED: 'inventory.stock-level.initialized'` to
  `ROUTING_KEYS` + the legacy message-pattern enum + the routing-keys spec.
- Extend `IStockEventsPublisherPort` + `StockRabbitmqPublisher` with
  `publishStockLevelInitialized(...)`. Emit it onto **`inventory_queue`** (the
  inventory service's own queue, a reserved surface — no cross-service consumer
  yet) via the `INVENTORY_MICROSERVICE` client. This means the inventory
  `StockModule` now imports `MicroserviceClientInventoryModule` (in addition to
  `MicroserviceClientNotificationModule` for stock-low), and the publisher injects
  both clients.

## Consumer placement

`apps/.../stock/infrastructure/consumers/catalog-events.consumer.ts` — a
`@Controller()` with `@EventPattern(ROUTING_KEYS.CATALOG_VARIANT_CREATED)` taking
`@Payload() event: ICatalogVariantCreatedEvent`, calling
`AutoInitStockLevelUseCase.execute(event)`. Log `correlationId` inline (ADR-011).
Register it in `StockModule.controllers`. Add an `infrastructure/consumers/index.ts`
barrel.

## Files to add

- `apps/.../stock/application/use-cases/auto-init-stock-level.use-case.ts` (+ `spec/`)
- `apps/.../stock/infrastructure/consumers/catalog-events.consumer.ts`
- `apps/.../stock/infrastructure/consumers/index.ts`
- `apps/.../stock/domain/events/stock-level-initialized.event.ts`
- `libs/contracts/inventory/events/stock-level-initialized.event.ts`
- `test/inventory-auto-init.e2e-spec.ts`
- `docs/implementation/04-inventory-stock-level-and-location/05-auto-init-on-variant-created.md`

## Files to modify

- `apps/.../stock/domain/events/index.ts` — barrel the new domain event.
- `apps/.../stock/application/use-cases/index.ts` — export the new use case.
- `apps/.../stock/application/ports/stock-events.publisher.port.ts` — add
  `publishStockLevelInitialized`.
- `apps/.../stock/infrastructure/messaging/stock-rabbitmq.publisher.ts` — inject
  the `INVENTORY_MICROSERVICE` client; implement the new emit.
- `apps/.../stock/infrastructure/stock.module.ts` — import
  `MicroserviceClientInventoryModule`; register the consumer + the new use case.
- `libs/contracts/inventory/events/index.ts` — barrel the new wire event.
- `libs/messaging/routing-keys.constants.ts` (+ spec) +
  `libs/contracts/microservices/microservice-message-pattern.enum.ts` — add
  `INVENTORY_STOCK_LEVEL_INITIALIZED`.
- `apps/catalog-microservice/.../catalog/infrastructure/messaging/catalog-rabbitmq.publisher.ts`
  — retarget `publishVariantCreated` to the `INVENTORY_MICROSERVICE` client /
  `inventory_queue`.
- The catalog Nest module that provides the publisher (`catalog.module.ts`) —
  import `MicroserviceClientInventoryModule` so the `INVENTORY_MICROSERVICE` client
  is injectable there.

## Files to delete

None.

## Tests

- **Unit** `auto-init-stock-level.use-case.spec.ts`:
  - New variant → saves `StockLevel.initialAt(...)` at `default-warehouse` and
    emits `inventory.stock-level.initialized` exactly once.
  - Repeat event for an existing `(variantId, default-warehouse)` → no save, no
    event (idempotent).
  - A simulated unique-violation from `saveStockLevel` is swallowed as the
    already-exists no-op (use a repository double).
- **E2E** `test/inventory-auto-init.e2e-spec.ts` (via `yarn test:e2e`):
  - Create a Product + Variant + publish via the catalog HTTP flow (reuse the
    catalog e2e's helpers/login).
  - Poll `GET /api/inventory/variants/:newVariantId/stock` until it returns a
    `default-warehouse` `StockLevel` with `quantityOnHand = 0`,
    `available = 0` (within a bounded timeout — the consumer is asynchronous).
  - Assert the row is created once (a second identical publish does not change the
    figure or duplicate the location entry).
- Confirm the **catalog e2e stays green** after the publisher retarget (the emit
  still succeeds; it now lands on `inventory_queue`).

## Doc deliverable

`05-auto-init-on-variant-created.md` — the new RMQ consumer; the cross-service
**delivery topology** (why the catalog publisher emits onto `inventory_queue`, the
producer-targets-consumer-queue pattern, and why a topic/fanout exchange was
*not* introduced — ADR-008 / ADR-020); the idempotency strategy (find-or-create +
the UNIQUE backstop); what happens if the consumer is down at variant-create time
(durable broker delivery on restart + lazy re-init on first stock op); the
`inventory.stock-level.initialized` reserved-surface event. Cross-link
`docs/adr/011-…md`, `docs/adr/020-…md`, and `06-receive-and-adjust-use-cases.md`
(for lazy re-init).

## Carryover to read

`carryover-01.md`, `carryover-02.md`, `carryover-03.md`.

## Carryover to produce

Write `carryover-04.md`. Capture: the consumer path + the `@EventPattern` it binds;
the `AutoInitStockLevelUseCase` contract + idempotency rule; that the catalog
publisher now emits `catalog.variant.created` onto `inventory_queue` (and that the
catalog module imports `MicroserviceClientInventoryModule`); that the inventory
`StockModule` now imports `MicroserviceClientInventoryModule` and the publisher
injects both the inventory + notification clients; the new domain + wire event +
routing key `inventory.stock-level.initialized`. Note the gaps owned by task-05
(Receive/Adjust + their events + low-stock + lazy re-init) and task-06
(README/CLAUDE + doc `08`). List the verify commands, including the asynchronous
poll against the inventory GET after a catalog variant create.

## Exit criteria

- [ ] Creating a Variant via the catalog flow results in a `StockLevel = 0` row at
      `default-warehouse` within seconds, observable via the inventory GET.
- [ ] The consumer is idempotent — a repeat `catalog.variant.created` does not
      duplicate the row or re-emit the initialized event.
- [ ] The catalog publisher emits `catalog.variant.created` onto `inventory_queue`;
      the catalog e2e and service boot stay green.
- [ ] `inventory.stock-level.initialized` exists in `ROUTING_KEYS`, the legacy
      enum, and the routing-keys spec; the publisher emits it; the wire + domain
      events exist.
- [ ] `auto-init-stock-level.use-case.spec.ts` and
      `test/inventory-auto-init.e2e-spec.ts` are green.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `yarn test:e2e` passes.
- [ ] `05-auto-init-on-variant-created.md` is written (no new ADR — the delivery
      topology applies ADR-008 / ADR-020).
- [ ] The self-containment grep is clean.
- [ ] `carryover-04.md` is written.
