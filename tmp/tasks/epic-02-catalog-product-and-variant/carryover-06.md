# Carryover 06 → task-07

Task-06 ("Publish Product + Archive Product use cases") is complete. This note is
the entry state for task-07 (the catalog read path).

## Entry state for task-07

- The catalog microservice now **handles four write commands** and **emits three
  events**. It still boots clean against a live MySQL + RabbitMQ; `catalog_queue`
  has one consumer; no DI errors.
- `catalog.controller.ts` now has `@MessagePattern` handlers for all four write
  commands: `catalog.product.register`, `catalog.variant.create`,
  `catalog.product.publish`, `catalog.product.archive`.
- `catalog.module.ts` registers all four use cases (`RegisterProductUseCase`,
  `AddVariantUseCase`, `PublishProductUseCase`, `ArchiveProductUseCase`); the
  repository + events-publisher bindings are unchanged.
- All gates green on a fresh run: `yarn lint` (exit 0, `--max-warnings 0`),
  `yarn test:unit` (**358 passed**, 52 suites — was 349/50; +9 use-case tests
  across the two new spec files, +2 suites; the routing-keys spec gained 4
  equality assertions inside the existing suite), `yarn build` (5 apps),
  `yarn test:e2e` (5 suites / 55 tests / 38 snapshots — unchanged; the catalog
  gateway endpoints arrive in task-08), self-containment grep clean.

## Four new routing keys (+ legacy-enum mirror + spec)

Added to `ROUTING_KEYS` (`libs/messaging/routing-keys.constants.ts`) **and** the
identical members to `MicroserviceMessagePatternEnum`
(`libs/contracts/microservices/microservice-message-pattern.enum.ts`); the
routing-keys spec (`libs/messaging/spec/routing-keys.constants.spec.ts`) asserts
equality for each (the dotted-regex loop already covers them):

| `ROUTING_KEYS` member | wire value | kind |
|---|---|---|
| `CATALOG_PRODUCT_PUBLISH` | `catalog.product.publish` | RPC command |
| `CATALOG_PRODUCT_ARCHIVE` | `catalog.product.archive` | RPC command |
| `CATALOG_PRODUCT_PUBLISHED` | `catalog.product.published` | event |
| `CATALOG_PRODUCT_ARCHIVED` | `catalog.product.archived` | event |

Command/event tense distinction holds: `catalog.product.publish` (RPC) vs
`catalog.product.published` (event), and `catalog.product.archive` vs
`catalog.product.archived` are **different keys**. The catalog now owns 7 keys
total (4 commands, 3 events).

## Two new event contracts + two command payloads (`libs/contracts/catalog/`)

- `events/product-published.event.ts` — `ICatalogProductPublishedEvent`:
  `{ productId, slug, variantIds: number[], publishedAt, eventVersion: 'v1',
  occurredAt, correlationId }` (extends `ICorrelationPayload`).
- `events/product-archived.event.ts` — `ICatalogProductArchivedEvent`:
  `{ productId, archivedAt, eventVersion: 'v1', occurredAt, correlationId }`.
- `interfaces/publish-product.interface.ts` — `IPublishProductPayload`
  (`{ productId, correlationId }`).
- `interfaces/archive-product.interface.ts` — `IArchiveProductPayload`
  (`{ productId, correlationId }`).
- All four barrels updated (`events/index.ts`, `interfaces/index.ts`).
- **`ProductView` extended** (`dto/product.view.ts`) with optional
  `publishedAt?: string` / `archivedAt?: string` — set only by the operation that
  performs the matching transition; absent on a plain register response. The view
  is reused as the response of all three product operations.

## Events publisher seam — now all three methods

- Port `application/ports/catalog-events.publisher.port.ts`
  (`ICatalogEventsPublisherPort`) now declares:
  `publishVariantCreated`, `publishProductPublished`, `publishProductArchived`
  (each `(event, correlationId?)`).
- Adapter `infrastructure/messaging/catalog-rabbitmq.publisher.ts`
  (`CatalogRabbitmqPublisher`) emits each event onto its routing key via
  `ClientProxy.emit(...)` + `firstValueFrom`. Still the only `ClientProxy` site in
  the catalog service. Thin by design — the use case builds the wire event.

## The two new use cases

- `application/use-cases/publish-product.use-case.ts` (`PublishProductUseCase`):
  loads (reject `PRODUCT_NOT_FOUND`), **runs the deferred price-precondition seam**
  (see below), `product.publish()` (domain enforces `draft` + ≥1 variant), saves,
  drains `pullDomainEvents()`, maps `ProductPublishedEvent` →
  `ICatalogProductPublishedEvent`, publishes `catalog.product.published`
  (best-effort post-commit, warn-and-swallow). Returns `ProductView`
  (`status: 'active'`, `publishedAt`).
- `application/use-cases/archive-product.use-case.ts` (`ArchiveProductUseCase`):
  loads (reject `PRODUCT_NOT_FOUND`), `product.archive()` (domain enforces
  `active`), saves, drains, maps `ProductArchivedEvent` →
  `ICatalogProductArchivedEvent`, publishes `catalog.product.archived`
  (best-effort). Returns `ProductView` (`status: 'archived'`, `archivedAt`).
- Both `publishedAt` / `archivedAt` (response **and** wire event) derive from the
  drained domain event's `occurredAt.toISOString()`; the wire events carry both a
  business timestamp (`publishedAt`/`archivedAt`) and the envelope `occurredAt`,
  set to the same instant today.

## Deferred price-precondition seam — LOCATION (task knows where this lives)

In **`publish-product.use-case.ts`**, immediately after the `findById` not-found
guard and **before** `product.publish()`. It is an inline `this.logger.warn(...)`
with the exact message **`active price precondition not yet enforced — pricing
capability pending`**, preceded by a `// Pricing precondition seam.` comment
block. It warns-and-proceeds: no hard block, no `Price` entity, no domain change.
A future pricing capability replaces the warn with a real "≥1 active Price"
assertion at that spot without reshaping the use case. The domain
(`Product.publish()`) still guards only the variant count (ADR-025) — do not add a
price check to the model.

## In-memory test doubles extended

`application/use-cases/spec/test-doubles.ts` — `InMemoryCatalogEventsPublisher`
gained `productPublished[]` / `productArchived[]` recorder arrays and the two new
port methods. The repository double is unchanged (publish/archive specs seed via
`Product.reconstitute(...)` with concrete ids; the publish happy path seeds a
draft product carrying one `ProductVariant`).

## Key decisions & deviations (task-07 must respect)

- **`PublishProductUseCase` / `ArchiveProductUseCase` drain events from the
  pre-save aggregate**, not the `save(...)` return value — same pattern as
  `AddVariantUseCase` (the reconstituted `saved` aggregate carries no events). The
  drained event supplies `slug` / `variantIds` / `occurredAt`; `productId` is the
  payload id (concrete, since the product was loaded).
- **No new `CatalogErrorCodeEnum` codes were needed.** Publish/archive reuse
  `PRODUCT_NOT_FOUND` (load guard), and the domain's existing
  `PRODUCT_INVALID_STATE_TRANSITION` (wrong state) and
  `PRODUCT_PUBLISH_REQUIRES_VARIANT` (no variants). The exception file is
  unchanged.
- **`ProductView` is shared across register/publish/archive** rather than minting
  a per-operation response DTO — the optional timestamps keep one DTO. task-07's
  read path may add its own view types (a list/detail product view, a top-level
  variant view); reuse `ProductVariantView` where it fits.
- **Archival semantics for the read path:** an archived product is **hidden from
  browse** — task-07's list MUST filter on `status = active` (the repository's
  `listActive` already does) — but stays **resolvable by id/slug** (a direct
  `findById` / `findBySlug` returns it regardless of status). Documented in doc 05
  §5.

## Known gaps (owned by later tasks)

- **Query read path** — `listActive(query)` exists on `ICatalogRepositoryPort` +
  `CatalogTypeormRepository` and filters on `status = active`; `findVariantById`
  exposes the top-level variant read model. task-07 fleshes out the read
  use case(s) + the `@MessagePattern` query handlers and the response views —
  **task-07**.
- **API gateway catalog module** (HTTP surface; maps `CatalogErrorCodeEnum` → HTTP
  status — `PRODUCT_NOT_FOUND`→404, `*_TAKEN`→409, invariant/transition codes→400)
  — **task-08**.
- **Kulala `http/catalog.http`** — **task-09**.
- **Seed + docs finalization** — **task-10** still owns: the catalog seed, the
  CLAUDE.md ADR "next free number" bump (still stale at "025" — ADR-025 is
  committed, should read "026") and a consolidated catalog domain section. (This
  task only updated the CLAUDE.md/README statements its own change made false —
  the architecture intro, queue note, message-pattern list, the catalog service
  section, the contracts sub-area, the cross-service-events note, the README
  diagram box + services table.)
- **Pricing capability** — the deferred "≥1 active Price" publish precondition is
  a warn-not-block seam in `publish-product.use-case.ts`; the future capability
  that owns `Price` turns it into a hard check. Not tasks 06–10.
- **`product_id` → `variantId` reshape** in inventory/retail + retail order-create
  validation against a published variant — later cross-context work, **not** tasks
  06–10 (from carryover-02/03).

## Docs written vs pending

- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md` —
  **extended**: now §1 use-case role, §2 Register, §3 Add Variant, **§4 Publish
  Product (incl. the deferred active-price seam), §5 Archive Product (incl. the
  hidden-from-browse / still-resolvable archival semantics)**, §6 the typed-error
  channel (table now includes the publish/archive rejections), §7
  publish-after-commit best-effort (now covers all three events), §8 ports + the
  `ProductView` timestamp note, §9 verification, "What this does not do". **Pending
  (task-07):** a read-path section (the closing paragraph flags it).
- `docs/implementation/02-catalog-product-and-variant/06-catalog-events.md` —
  **complete**: §1 the full 7-key command-vs-event table, §2 all three wire-event
  payloads + the per-event-type `v1` versioning rationale, §3 publisher
  port/adapter (now three methods), §4 events-ride-`catalog_queue` +
  no-consumer-yet, §5 the contracts surface, §6 verification, "What this does not
  do".

## Files added

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/archive-product.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/archive-product.use-case.spec.ts`
- `libs/contracts/catalog/events/product-published.event.ts`
- `libs/contracts/catalog/events/product-archived.event.ts`
- `libs/contracts/catalog/interfaces/publish-product.interface.ts`
- `libs/contracts/catalog/interfaces/archive-product.interface.ts`

## Files modified

- `libs/messaging/routing-keys.constants.ts`,
  `libs/messaging/spec/routing-keys.constants.spec.ts`
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`
- `libs/contracts/catalog/events/index.ts`,
  `libs/contracts/catalog/interfaces/index.ts`,
  `libs/contracts/catalog/dto/product.view.ts`
- `apps/catalog-microservice/src/modules/catalog/application/ports/catalog-events.publisher.port.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/catalog-rabbitmq.publisher.ts`
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/index.ts`
- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/test-doubles.ts`
- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md`
- `docs/implementation/02-catalog-product-and-variant/06-catalog-events.md`
- `CLAUDE.md`, `README.md`

## Files deleted

- None.

## How to verify

```bash
yarn lint                 # --max-warnings 0, exit 0
yarn test:unit            # 358 passed, 52 suites
yarn build                # 5 apps compile

# Regression (infra reload → migrate → seed → tests):
yarn test:e2e             # 5 suites / 55 tests / 38 snapshots (unchanged — no
                          #   catalog gateway endpoint yet; arrives in task-08)

# Boot the catalog service against running infra (DI graph + handler registration):
docker compose up -d rabbitmq mysql redis
OTEL_SDK_DISABLED=true node dist/apps/catalog-microservice/main.js
#   → "Catalog Microservice is listening for messages", no DI errors
docker exec rabbitmq rabbitmqctl list_queues name consumers   # catalog_queue → 1

# Self-containment gate (expected: no orchestration references):
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
```

Note: infra (rabbitmq/mysql/redis) was left **up and seeded** after the e2e run;
tear it down with `yarn test:infra:down` for a clean slate.
