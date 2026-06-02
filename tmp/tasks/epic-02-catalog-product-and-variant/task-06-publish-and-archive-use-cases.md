---
epic: epic-02
task_number: 6
title: Publish Product + Archive Product use cases
depends_on: [task-01, task-02, task-03, task-04, task-05]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/06-catalog-events.md
adr_deliverable: none
---

# Task 06 — Publish Product + Archive Product use cases

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the `docs/adr/` documents related to this task.

Most relevant ADRs: **ADR-008 + ADR-020** (routing keys; publisher seam),
**ADR-011** (wire-event interfaces; inline `correlationId` logging), **ADR-013**
(events drained via `pullDomainEvents()` after the state transition), **ADR-004 /
ADR-017** (boundaries).

## Goal

Implement the two lifecycle write operations — **Publish Product** (`draft →
active`; precondition ≥1 variant; emits `catalog.product.published`) and
**Archive Product** (`active → archived`; emits `catalog.product.archived`) —
reusing the event seam stood up in task-05. Complete the events doc.

## Entry state assumed

- task-01–05 carryover present. The write seam exists: `ICatalogEventsPublisherPort`
  (`CATALOG_EVENTS_PUBLISHER`) with `publishVariantCreated`, the
  `CatalogRabbitmqPublisher` adapter, `MicroserviceClientCatalogModule`, the
  `catalog.controller.ts` with the register + create-variant handlers, and
  `libs/contracts/catalog/`.
- The domain already has `Product.publish()` / `Product.archive()` recording
  `ProductPublishedEvent` / `ProductArchivedEvent` (task-03).
- `ROUTING_KEYS` has the task-05 keys; it does **not** yet have the publish/archive
  command or event keys.

## Scope

**In**

- `PublishProductUseCase`, `ArchiveProductUseCase`, their specs.
- Routing keys for the publish/archive commands and their events, mirrored in the
  legacy enum + routing-keys spec.
- `ICatalogProductPublishedEvent` / `ICatalogProductArchivedEvent` contracts.
- `publishProductPublished` / `publishProductArchived` on the publisher port +
  adapter.
- `@MessagePattern` handlers for the two commands.
- Complete `06-catalog-events.md`; extend `05-catalog-use-cases.md`.

**Out**

- The read path (task-07); the gateway (task-08).
- A real "≥1 active Price" check — Price is owned by a **future pricing
  capability**; until it lands, the publish path logs a warning and proceeds (see
  below). Do not implement a Price entity or a hard block here.

## Routing keys (add + mirror + assert, per the task-05 procedure)

| `ROUTING_KEYS` member | wire value | kind |
|---|---|---|
| `CATALOG_PRODUCT_PUBLISH` | `catalog.product.publish` | RPC command |
| `CATALOG_PRODUCT_ARCHIVE` | `catalog.product.archive` | RPC command |
| `CATALOG_PRODUCT_PUBLISHED` | `catalog.product.published` | event |
| `CATALOG_PRODUCT_ARCHIVED` | `catalog.product.archived` | event |

Add each to `ROUTING_KEYS` **and** `MicroserviceMessagePatternEnum`, and add
equality assertions to `libs/messaging/spec/routing-keys.constants.spec.ts`.
(`catalog.product.publish` vs `catalog.product.published` and
`catalog.product.archive` vs `catalog.product.archived` are distinct keys.)

## Contracts (`libs/contracts/catalog/events/`)

Extend `ICorrelationPayload` + `occurredAt: string` (ADR-011):

- `ICatalogProductPublishedEvent` — `{ productId, slug, variantIds: number[], publishedAt, eventVersion: 'v1', occurredAt, correlationId }`.
- `ICatalogProductArchivedEvent` — `{ productId, archivedAt, eventVersion: 'v1', occurredAt, correlationId }`.

Also add command payloads as needed (`IPublishProductPayload` /
`IArchiveProductPayload` carrying `{ productId, correlationId }`) and reuse
`ProductView` for the responses (`{ id, status: 'active', publishedAt }` /
`{ id, status: 'archived', archivedAt }` — extend `ProductView` or add a small
response DTO if the timestamp must be returned).

## Use cases (`application/use-cases/`)

- `PublishProductUseCase` — loads the `Product` (reject not-found), calls
  `product.publish()` (the domain enforces `draft` + ≥1 variant and raises a
  `DomainException` otherwise), persists, drains `pullDomainEvents()`, publishes
  `catalog.product.published`. **Price precondition:** before publishing, where a
  future pricing capability would assert "≥1 active Price", log a `warn` ("active
  price precondition not yet enforced — pricing capability pending") and proceed.
  Leave a clearly-named seam (e.g. a `// pricing precondition` comment and/or an
  injectable check that currently no-ops) so the future capability slots in
  without reshaping the use case. Do **not** reference the planning process in
  the comment.
- `ArchiveProductUseCase` — loads the `Product` (reject not-found), calls
  `product.archive()` (domain enforces `active`), persists, drains events,
  publishes `catalog.product.archived`. An archived product is hidden from browse
  (task-07's list filters on `status=active`) but stays resolvable by id/slug.

Post-commit publish failures are `warn`-logged and swallowed (ADR-020).

## Publisher + presentation

- Add `publishProductPublished(event, correlationId?)` and
  `publishProductArchived(event, correlationId?)` to `ICatalogEventsPublisherPort`
  and `CatalogRabbitmqPublisher` (`emit` the two event keys).
- Add `@MessagePattern(ROUTING_KEYS.CATALOG_PRODUCT_PUBLISH)` and
  `@MessagePattern(ROUTING_KEYS.CATALOG_PRODUCT_ARCHIVE)` handlers to
  `catalog.controller.ts`; register the two use cases in `catalog.module.ts`.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/archive-product.use-case.ts`
- Use-case specs (see Tests).
- `libs/contracts/catalog/events/` event interfaces (if not already a folder).

## Files to modify

- `libs/messaging/routing-keys.constants.ts`
- `libs/messaging/spec/routing-keys.constants.spec.ts`
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`
- `libs/contracts/catalog/` (barrel + new payloads/events)
- `apps/catalog-microservice/src/modules/catalog/application/ports/catalog-events.publisher.port.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/catalog-rabbitmq.publisher.ts`
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/index.ts`
- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts`

## Files to delete

- None.

## Tests

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts`
  — happy path (`draft`+≥1 variant → `active`, emits `catalog.product.published`
  with the right `variantIds`) + **no-variants-rejected** + (optional) asserts the
  warn-and-proceed path for the deferred price precondition.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/archive-product.use-case.spec.ts`
  — happy path (`active → archived`, emits `catalog.product.archived`) +
  reject-archive-on-non-active.
- Extend the routing-keys spec with the four new keys.
- `yarn test:e2e` stays green (gateway endpoints arrive in task-08).

## Doc deliverable

- **Complete** `docs/implementation/02-catalog-product-and-variant/06-catalog-events.md`
  — add the `published` / `archived` payloads, the command-vs-event key table,
  and the `v1` versioning rationale (versioned by event type from day one).
- **Extend** `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md`
  — the Publish/Archive sections, including the deferred-price-precondition seam
  (described as a future pricing capability) and the archival semantics
  (hidden-from-browse, still resolvable).

## Carryover to read

`carryover-01.md` … `carryover-05.md`.

## Carryover to produce

Write `carryover-06.md` capturing: the four new routing keys + mirror; the two
new event contracts; the publisher port now has all three publish methods; the
controller now handles all four write commands; the deferred price-precondition
seam location; doc 06 complete and doc 05 extended; verification commands.

## Exit criteria

- [ ] `PublishProductUseCase` (`draft→active`, ≥1 variant, emits
      `catalog.product.published`) and `ArchiveProductUseCase` (`active→archived`,
      emits `catalog.product.archived`) exist with specs.
- [ ] The four new routing keys exist in `ROUTING_KEYS` +
      `MicroserviceMessagePatternEnum` and are asserted in the spec.
- [ ] The publisher port/adapter publish all three catalog events; the controller
      handles all four write commands.
- [ ] The deferred "active Price" precondition warns-and-proceeds via a named
      seam (no hard block, no Price entity, no planning-process reference).
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` passes;
      `yarn test:e2e` passes.
- [ ] Doc 06 is complete; doc 05 has the Publish/Archive sections.
- [ ] The self-containment grep is clean:
      `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- [ ] `carryover-06.md` is written.
