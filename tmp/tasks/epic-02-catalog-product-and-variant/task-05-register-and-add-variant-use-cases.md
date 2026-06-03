---
epic: epic-02
task_number: 5
title: Register Product + Add Variant use cases and the event seam
depends_on: [task-01, task-02, task-03, task-04]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md
adr_deliverable: none
---

# Task 05 — Register Product + Add Variant use cases and the event seam

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the `docs/adr/` documents related to this task.

Most relevant ADRs: **ADR-008 + ADR-020** (RabbitMQ wiring; dotted routing keys;
`@nestjs/microservices` only in `infrastructure/messaging/*-rabbitmq.publisher.ts`;
publishers materialize `emit()` with `firstValueFrom`), **ADR-011** (wire events
are plain interfaces extending `ICorrelationPayload` + `occurredAt: string` —
never serialize `DomainEvent` subclasses; log `correlationId` inline inside
handlers), **ADR-013** (use-case constructs the wire event after the repository
assigns the id; the `IInventoryConfirmGatewayPort` precedent for a port that
hides `ClientProxy`), **ADR-004 / ADR-017** (layer boundaries).

## Goal

Implement the first two write operations — **Register Product** (creates a
`draft`, no variants) and **Add Variant** (appends a variant; `sku` globally
unique; emits `catalog.variant.created`) — and stand up the catalog write seam
they need: the command routing keys, the wire contracts, the event-publisher
port + RMQ adapter, the catalog messaging client module, and the
`@MessagePattern` handlers the gateway will call in task-08.

## Entry state assumed

- task-01–04 carryover present. The catalog domain + persistence are in place:
  `Product`/`ProductVariant`, `ICatalogRepositoryPort` (`CATALOG_REPOSITORY`),
  `product`/`product_variant` tables, `DatabaseModule.forRoot` wired.
- `ROUTING_KEYS` (`libs/messaging/routing-keys.constants.ts`) and
  `MicroserviceMessagePatternEnum` (`libs/contracts/microservices/microservice-message-pattern.enum.ts`)
  have **no** catalog members yet. There is no `libs/contracts/catalog/`.
- `MicroserviceClientTokenEnum` has no `CATALOG_MICROSERVICE`; there is no
  `MicroserviceClientCatalogModule`.

## Scope

**In**

- `RegisterProductUseCase`, `AddVariantUseCase`, their specs.
- Command routing keys + the `catalog.variant.created` event key, mirrored in
  the legacy enum and asserted in the routing-keys spec.
- `libs/contracts/catalog/` command payloads, view DTOs, and the variant-created
  event interface.
- `ICatalogEventsPublisherPort` (`CATALOG_EVENTS_PUBLISHER`) + the RMQ adapter.
- `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE` + `MicroserviceClientCatalogModule`.
- `catalog.controller.ts` `@MessagePattern` handlers for the two commands.

**Out**

- Publish / Archive (task-06); the read path (task-07); the gateway (task-08).
- Auto-initializing `StockLevel = 0` on `VariantCreated` — this work only
  **emits** the event; the inventory consumer is owned by a later inventory
  capability. Do not add a consumer here.

## Routing keys (add to `ROUTING_KEYS` and mirror in the legacy enum)

The routing-keys contract spec (`libs/messaging/spec/routing-keys.constants.spec.ts`)
asserts every `ROUTING_KEYS.*` equals the matching `MicroserviceMessagePatternEnum.*`
value, and that every value matches the dotted regex. So for each key below:
add it to `ROUTING_KEYS`, add the identical member to
`MicroserviceMessagePatternEnum`, and add an explicit equality assertion to the
spec.

| `ROUTING_KEYS` member | wire value | kind |
|---|---|---|
| `CATALOG_PRODUCT_REGISTER` | `catalog.product.register` | RPC command |
| `CATALOG_VARIANT_CREATE` | `catalog.variant.create` | RPC command |
| `CATALOG_VARIANT_CREATED` | `catalog.variant.created` | event |

Note the command/event distinction: `catalog.variant.create` (imperative RPC)
vs `catalog.variant.created` (past-tense event) are **different** keys.

## Contracts (`libs/contracts/catalog/`, exported from the contracts barrel)

Create `libs/contracts/catalog/` mirroring `libs/contracts/{inventory,retail}/`
and add `export * from './catalog';` to `libs/contracts/index.ts`.

- **Command payloads** (extend `ICorrelationPayload` — carry `correlationId`):
  - `IRegisterProductPayload` — `{ name, slug, description, correlationId }`.
  - `ICreateVariantPayload` — `{ productId, sku, gtin?, optionValues: Record<string,string>, weightG?, dimensionsMm?, correlationId }`.
- **View DTOs** (RPC responses; plain DTOs, `class-validator`/Swagger allowed in
  contracts):
  - `ProductView` — `{ id, name, slug, description, status }`.
  - `ProductVariantView` — `{ id, productId, sku, gtin, optionValues, weightG, dimensionsMm, status }`.
- **Event interface** (extends `ICorrelationPayload`, plus `occurredAt: string`
  per ADR-011):
  - `ICatalogVariantCreatedEvent` — `{ productId, variantId, sku, eventVersion: 'v1', occurredAt, correlationId }`.

## Use cases (`application/use-cases/`)

- `RegisterProductUseCase` — validates + builds a `Product` in `draft`, rejects a
  **duplicate slug** (via `ICatalogRepositoryPort.existsBySlug` → raise a
  `DomainException` mapped to an RPC error), persists, returns a `ProductView`.
- `AddVariantUseCase` — loads the parent `Product` (reject **parent-not-found**),
  builds a `ProductVariant` (reject **duplicate sku** via `existsBySku`), calls
  `product.addVariant(...)` (records `VariantCreatedEvent`), persists, then
  drains `pullDomainEvents()` and publishes the wire `catalog.variant.created`
  via `ICatalogEventsPublisherPort`. Construct the wire event **after** the
  repository assigns `variantId` (ADR-013). Post-commit publish failures are
  `warn`-logged and swallowed (ADR-020) — the variant is persisted regardless.

## Event publisher seam

- Port `application/ports/catalog-events.publisher.port.ts`:
  `ICatalogEventsPublisherPort` + `CATALOG_EVENTS_PUBLISHER`. Method (this task):
  `publishVariantCreated(event, correlationId?)`. (Task-06 adds
  `publishProductPublished` / `publishProductArchived`.)
- Adapter `infrastructure/messaging/catalog-rabbitmq.publisher.ts`:
  `CatalogRabbitmqPublisher implements ICatalogEventsPublisherPort`, injects the
  catalog `ClientProxy` via `@Inject(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE)`,
  `emit(ROUTING_KEYS.CATALOG_VARIANT_CREATED, wire)` materialized with
  `firstValueFrom` (model on `OrderRabbitmqPublisher`). The catalog events ride
  `catalog_queue`; no consumer exists yet (a later inventory capability binds
  one) — emitting to a queue with no matching handler is the same
  reserved-surface pattern as `retail.order.confirmed` today.

## Messaging client module (`libs/messaging/`)

- Add `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE = 'CATALOG_MICROSERVICE'`
  to `libs/contracts/microservices/microservice-client-token.enum.ts`.
- Add `libs/messaging/microservice-client-catalog.module.ts`
  (`MicroserviceClientCatalogModule`) mirroring
  `microservice-client-notification.module.ts`: `ClientsModule.registerAsync`
  with `new MicroserviceClientConfiguration(MicroserviceClientTokenEnum.CATALOG_MICROSERVICE, MicroserviceQueueEnum.CATALOG_QUEUE)`.
- Export it from `libs/messaging/index.ts`.

## Presentation handlers (`presentation/catalog.controller.ts`)

Create the controller with `@MessagePattern` handlers (model on
`stock.controller.ts` / `orders.controller.ts`):

- `@MessagePattern(ROUTING_KEYS.CATALOG_PRODUCT_REGISTER)` → `RegisterProductUseCase`.
- `@MessagePattern(ROUTING_KEYS.CATALOG_VARIANT_CREATE)` → `AddVariantUseCase`.

Handlers translate the wire payload into the use-case call and log
`correlationId` inline (ADR-001/011 — `PinoLogger.assign()` throws outside
request scope). Wire the controller + use cases + the two new providers
(`CATALOG_EVENTS_PUBLISHER → CatalogRabbitmqPublisher`) and
`MicroserviceClientCatalogModule` into `catalog.module.ts`.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/register-product.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/add-variant.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/index.ts`
- `apps/catalog-microservice/src/modules/catalog/application/ports/catalog-events.publisher.port.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/catalog-rabbitmq.publisher.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/index.ts`
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts`
- `apps/catalog-microservice/src/modules/catalog/presentation/index.ts`
- `libs/messaging/microservice-client-catalog.module.ts`
- `libs/contracts/catalog/` (payloads, views, event interface, barrel `index.ts`)
- Use-case specs (see Tests).

## Files to modify

- `libs/messaging/routing-keys.constants.ts`
- `libs/messaging/index.ts`
- `libs/messaging/spec/routing-keys.constants.spec.ts`
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`
- `libs/contracts/microservices/microservice-client-token.enum.ts`
- `libs/contracts/index.ts`
- `apps/catalog-microservice/src/modules/catalog/application/ports/index.ts`
- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts`

## Files to delete

- None.

## Tests

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/register-product.use-case.spec.ts`
  — happy path + duplicate-slug-rejected (repository test double returns
  `existsBySlug → true`).
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/add-variant.use-case.spec.ts`
  — happy path + duplicate-sku-rejected + parent-not-found-rejected + **emits
  `catalog.variant.created`** (assert the publisher port was called with the
  right payload, including the persisted `variantId`).
- Extend `libs/messaging/spec/routing-keys.constants.spec.ts` with equality
  assertions for the three new keys (the dotted-regex loop covers them already).
- `yarn test:e2e` stays green (the gateway endpoints arrive in task-08).

## Doc deliverable

Start two docs (each completed/extended by later tasks — note that in the doc
text without referencing the planning process):

- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md` —
  the write use-case shapes (Register, Add Variant), the ports they depend on,
  the repository-level slug/sku uniqueness enforcement, and the
  publish-after-commit / best-effort-publish rules. Leave room for the
  Publish/Archive (task-06) and read (task-07) sections.
- `docs/implementation/02-catalog-product-and-variant/06-catalog-events.md` —
  the routing-key naming (command vs event), the `catalog.variant.created`
  payload + `v1` versioning rationale, the publisher port/adapter seam, the
  `catalog_queue`-rides-events model, and the no-consumer-yet note. Leave room
  for the published/archived events (task-06).

## Carryover to read

`carryover-01.md` … `carryover-04.md`.

## Carryover to produce

Write `carryover-05.md` capturing: the three new routing keys + their legacy-enum
mirror; the `libs/contracts/catalog/` surface (payload/view/event names); the
`CATALOG_EVENTS_PUBLISHER` symbol + adapter; `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE`
+ `MicroserviceClientCatalogModule`; the two `@MessagePattern` keys now handled;
which sections of docs 05 + 06 are written vs still pending; verification commands.

## Exit criteria

- [ ] `RegisterProductUseCase` + `AddVariantUseCase` exist with specs covering
      happy path, duplicate-slug, duplicate-sku, parent-not-found, and the emitted
      `catalog.variant.created`.
- [ ] The three routing keys exist in both `ROUTING_KEYS` and
      `MicroserviceMessagePatternEnum`; the routing-keys spec asserts them.
- [ ] `libs/contracts/catalog/` exists and is exported from the contracts barrel.
- [ ] `ICatalogEventsPublisherPort` + adapter + `MicroserviceClientCatalogModule`
      + `CATALOG_MICROSERVICE` client token are wired; the catalog `ClientProxy`
      lives only in the publisher adapter (ADR-009/020 boundary green).
- [ ] `catalog.controller.ts` handles `catalog.product.register` and
      `catalog.variant.create`.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` passes;
      `yarn test:e2e` passes.
- [ ] The 05 + 06 docs are started.
- [ ] The self-containment grep is clean:
      `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- [ ] `carryover-05.md` is written.
