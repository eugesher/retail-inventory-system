# Carryover 05 → task-06

Task-05 ("Register Product + Add Variant use cases and the event seam") is
complete. This note is the entry state for task-06 (publish + archive use cases).

## Entry state for task-06

- The catalog microservice now **handles two write commands** and **emits one
  event**. It boots clean against a live MySQL + RabbitMQ (verified): logs
  `Catalog Microservice is listening for messages`, `catalog_queue` shows 1
  consumer, no DI errors.
- `catalog.module.ts` now wires the controller, both use cases, the events
  publisher, and `MicroserviceClientCatalogModule` (the `catalog_queue`
  `ClientProxy`) in addition to the repository it already had.
- All gates green on a fresh run: `yarn lint` (exit 0, `--max-warnings 0`),
  `yarn test:unit` (**349 passed**, 50 suites — was 343/48; +6 use-case tests,
  +2 suites; the routing-keys spec gained 3 assertions in the existing suite),
  `yarn build` (5 apps), `yarn test:e2e` (5 suites / 55 tests / 38 snapshots —
  unchanged; the catalog gateway endpoints arrive in task-08), self-containment
  grep clean.

## Three new routing keys (+ legacy-enum mirror)

Added to `ROUTING_KEYS` (`libs/messaging/routing-keys.constants.ts`) **and** the
identical members to `MicroserviceMessagePatternEnum`
(`libs/contracts/microservices/microservice-message-pattern.enum.ts`); the
routing-keys spec asserts equality for each (the dotted-regex loop already
covers them):

| `ROUTING_KEYS` member | wire value | kind |
|---|---|---|
| `CATALOG_PRODUCT_REGISTER` | `catalog.product.register` | RPC command |
| `CATALOG_VARIANT_CREATE` | `catalog.variant.create` | RPC command |
| `CATALOG_VARIANT_CREATED` | `catalog.variant.created` | event |

Command/event tense distinction: `catalog.variant.create` (imperative RPC) vs
`catalog.variant.created` (past-tense event) are **different keys**.

**task-06 adds** `CATALOG_PRODUCT_PUBLISH` / `CATALOG_PRODUCT_ARCHIVE` (commands)
and `CATALOG_PRODUCT_PUBLISHED` / `CATALOG_PRODUCT_ARCHIVED` (events) the same
way (constant + enum mirror + spec assertion).

## `libs/contracts/catalog/` surface (new, exported from the contracts barrel)

Mirrors `libs/contracts/{inventory,retail}/`; `export * from './catalog'` added
to `libs/contracts/index.ts`.

- `interfaces/` — `IRegisterProductPayload` (`{ name, slug, description?,
  correlationId }`), `ICreateVariantPayload` (`{ productId, sku, gtin?,
  optionValues, weightG?, dimensionsMm?, correlationId }`). Both extend
  `ICorrelationPayload`.
- `dto/` — `ProductView` (`{ id, name, slug, description, status }`),
  `ProductVariantView` (`{ id, productId, sku, gtin, optionValues, weightG,
  dimensionsMm, status }`) + the nested `VariantDimensionsView`. Classes with
  `@nestjs/swagger` `@ApiResponseProperty` (the documented contracts exception).
  `status` is typed `string` — the catalog status enums stay in `domain/`, never
  in contracts (ADR-025 §7); the wire carries the raw value.
- `events/` — `ICatalogVariantCreatedEvent` (`{ productId, variantId, sku,
  eventVersion: 'v1', occurredAt, correlationId }`), extends `ICorrelationPayload`.

## Events publisher seam

- Port `application/ports/catalog-events.publisher.port.ts`:
  `ICatalogEventsPublisherPort` + `CATALOG_EVENTS_PUBLISHER` symbol. Method:
  `publishVariantCreated(event: ICatalogVariantCreatedEvent, correlationId?)`.
  **task-06 adds** `publishProductPublished` / `publishProductArchived` here.
- Adapter `infrastructure/messaging/catalog-rabbitmq.publisher.ts`
  (`CatalogRabbitmqPublisher`): injects the `CATALOG_MICROSERVICE` `ClientProxy`,
  `emit(ROUTING_KEYS.CATALOG_VARIANT_CREATED, event)` materialized with
  `firstValueFrom`. **Thin by design** — the use case builds the wire event (see
  Key decisions); the adapter only hides `ClientProxy` behind the port. The only
  `ClientProxy` site in the catalog service (ADR-009/020 boundary green).

## Messaging client token + module

- `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE = 'CATALOG_MICROSERVICE'`
  added to `libs/contracts/microservices/microservice-client-token.enum.ts`.
- `libs/messaging/microservice-client-catalog.module.ts`
  (`MicroserviceClientCatalogModule`) — `ClientsModule.registerAsync` with
  `new MicroserviceClientConfiguration(CATALOG_MICROSERVICE, CATALOG_QUEUE)`;
  exported from `libs/messaging/index.ts`. The catalog service publishes its own
  events back onto `catalog_queue` (same queue it listens on); no consumer yet.

## `@MessagePattern` keys now handled

`presentation/catalog.controller.ts` (thin; `correlationId` logged inline in the
use cases):

- `catalog.product.register` → `RegisterProductUseCase` → `ProductView`.
- `catalog.variant.create` → `AddVariantUseCase` → `ProductVariantView`.

## Key decisions & deviations (task-06 must respect)

- **Three error codes added to `CatalogErrorCodeEnum`** (in
  `domain/catalog.exception.ts`): `PRODUCT_NOT_FOUND`, `PRODUCT_SLUG_TAKEN`,
  `VARIANT_SKU_TAKEN`. These are **repository-level** rejections (the aggregate
  cannot see other aggregates), pre-checked in the use cases via
  `existsBySlug`/`existsBySku`/`findById` and raised as a `CatalogDomainException`
  with a typed code — the single typed-error channel ADR-025 prescribes, which
  task-08's presentation/gateway maps to an HTTP status. The UNIQUE constraints
  remain the hard guard; the pre-check is only for a clean error message. The
  task's "Files to modify" list did not name the exception file — this is a
  small, justified deviation (the codes are needed to raise the rejections the
  task requires). task-06 likely adds a publish-precondition code (e.g.
  `PRODUCT_PUBLISH_REQUIRES_VARIANT` already exists in the enum from task-03).
- **The wire event is built in the use case, not the adapter** (divergence from
  retail's `OrderRabbitmqPublisher`, which maps inside the adapter). ADR-025
  places the `pullDomainEvents()` drain + wire mapping at the application layer,
  because the concrete `variantId` is only known after `save` re-reads the graph.
  `AddVariantUseCase` re-reads the persisted variant by its globally-unique
  `sku`, builds `ICatalogVariantCreatedEvent` with the concrete id, and passes it
  to the thin adapter. **task-06's publish event** carries `variantIds` already
  concrete (publish runs against a persisted product), so the use case can build
  the wire event directly from the drained `ProductPublishedEvent`.
- **Publish is best-effort post-commit** (ADR-020): `AddVariantUseCase`
  `warn`-logs and swallows a publish failure — the variant is persisted
  regardless. task-06's publish/archive use cases follow the same rule.
- **`RegisterProductUseCase` builds the aggregate first** (domain validates
  name/slug), then `existsBySlug`, then `save`. No event — `Product.create`
  records none (ADR-025).
- **In-memory test doubles** live at
  `application/use-cases/spec/test-doubles.ts` (jest-free, so the production
  build that includes `test-doubles.ts` stays clean — same constraint as
  retail). `InMemoryCatalogRepository.save` assigns concrete product+variant ids
  and re-reads (mimics the TypeORM adapter's post-commit re-read), with
  `slugTaken`/`skuTaken` override flags. `InMemoryCatalogEventsPublisher` records
  `published` calls. **task-06 extends these doubles** (e.g. seed an active
  product to archive; add `publishProductPublished`/`Archived` recorders).

## Known gaps (owned by later tasks)

- **Publish + archive use cases** — the "≥1 active Price" **warn-not-block** seam
  lives in the publish use case (the domain only guards "≥1 variant"); maps
  `ProductPublishedEvent`/`ProductArchivedEvent` to versioned `v1` wire events —
  **task-06**.
- **Query read path** (`listActive` exists on the port + adapter; top-level
  variant read model / `findVariantById` exposure) — **task-07**.
- **API gateway catalog module** (HTTP surface; maps `CatalogErrorCodeEnum` →
  HTTP status — `PRODUCT_NOT_FOUND`→404, `*_TAKEN`→409, invariant codes→400) —
  **task-08**.
- **Kulala `http/catalog.http`** — **task-09**.
- **Seed + docs finalization** — **task-10** still owns: the catalog seed, the
  CLAUDE.md ADR "next free number" bump (still stale at "025" — ADR-025 is
  committed, should read "026") and a consolidated catalog domain section. (This
  task only updated the CLAUDE.md/README statements its own change made false —
  message patterns, the catalog service section, the contracts/messaging lib
  notes, the events note, the README diagram + services table.)
- **`product_id` → `variantId` reshape** in inventory/retail + retail
  order-create validation against a published variant — later cross-context work,
  **not** tasks 06–10 (from carryover-02/03).

## Docs written vs pending

- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md` —
  **written**: §1 use-case role, §2 Register Product, §3 Add Variant (incl. the
  re-read-id rationale), §4 the typed-error channel, §5 publish-after-commit
  best-effort, §6 ports, §7 verification, "What this does not do". **Pending
  (task-06/07):** a Publish/Archive section and a read-path note (the doc's
  closing paragraph flags both).
- `docs/implementation/02-catalog-product-and-variant/06-catalog-events.md` —
  **written**: §1 routing-key command-vs-event naming, §2 the
  `catalog.variant.created` payload + `v1` rationale, §3 publisher port/adapter
  (incl. the build-in-use-case divergence), §4 events-ride-`catalog_queue` +
  no-consumer-yet, §5 the contracts surface, §6 verification, "What this does not
  do". **Pending (task-06):** the published/archived events section (flagged in
  the closing paragraph).

## Files added

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/register-product.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/add-variant.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/index.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/test-doubles.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/register-product.use-case.spec.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/add-variant.use-case.spec.ts`
- `apps/catalog-microservice/src/modules/catalog/application/ports/catalog-events.publisher.port.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/catalog-rabbitmq.publisher.ts`
- `apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/index.ts`
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts`
- `apps/catalog-microservice/src/modules/catalog/presentation/index.ts`
- `libs/messaging/microservice-client-catalog.module.ts`
- `libs/contracts/catalog/index.ts`,
  `interfaces/{register-product.interface,create-variant.interface,index}.ts`,
  `dto/{product.view,product-variant.view,index}.ts`,
  `events/{variant-created.event,index}.ts`
- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md`
- `docs/implementation/02-catalog-product-and-variant/06-catalog-events.md`

## Files modified

- `libs/messaging/routing-keys.constants.ts`, `libs/messaging/index.ts`,
  `libs/messaging/spec/routing-keys.constants.spec.ts`
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`,
  `libs/contracts/microservices/microservice-client-token.enum.ts`,
  `libs/contracts/index.ts`
- `apps/catalog-microservice/src/modules/catalog/application/ports/index.ts`
- `apps/catalog-microservice/src/modules/catalog/domain/catalog.exception.ts`
  (+3 error codes)
- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts`
- `CLAUDE.md`, `README.md`

## Files deleted

- None.

## How to verify

```bash
yarn lint                 # --max-warnings 0, exit 0
yarn test:unit            # 349 passed, 50 suites
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
