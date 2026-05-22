---
epic: epic-02
task_number: 3
title: Implement Register Product + Add Variant use cases + event-publisher port + RMQ adapter + routing keys
depends_on: [task-01, task-02]
doc_deliverable_primary: docs/implementation/epic-02-catalog-product-and-variant/04-catalog-use-cases.md
doc_deliverable_secondary: docs/implementation/epic-02-catalog-product-and-variant/05-catalog-events.md
---

# Task 03 — `Register Product` + `Add Variant` use cases + catalog event wiring

## Goal

Add the two creation-side use cases (`Register Product`, `Add Variant`) and the supporting messaging plumbing: the event-publisher port, the RabbitMQ publisher adapter, the new routing-key constants, and a "catalog command" RPC handler shell that lets the gateway send commands to the catalog-microservice. After this task, registering a Product and adding a Variant works end-to-end inside the catalog-microservice (driven by spec tests), and `VariantCreated` rides the bus so `epic-04` can later attach an inventory consumer.

This task does not yet wire the api-gateway side — that arrives in task-06. Today, the use cases are exercised by their unit specs; an e2e cannot pass until task-06 adds the controller.

## Entry state assumed

Tasks 1–2 carryover present:

- `apps/catalog-microservice/` boots; `Product`/`ProductVariant` domain + persistence are in place.
- `IProductRepositoryPort` + `PRODUCT_REPOSITORY` token are exported by `CatalogModule`.
- `MicroserviceQueueEnum.CATALOG_QUEUE` and `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE` exist; `MicroserviceClientCatalogModule` exports a `ClientProxy` bound to `catalog_queue`.
- `libs/messaging/routing-keys.constants.ts` still lists only the existing 10 keys (no `catalog.*`).

## Scope

**In:**

- Two use cases under `apps/catalog-microservice/src/modules/catalog/application/use-cases/`:
  - `register-product.use-case.ts` — accepts `{ name, slug, description? }`, validates slug uniqueness via the repo, persists a draft Product, returns the persisted aggregate.
  - `add-variant.use-case.ts` — accepts `{ productId, sku, gtin?, optionValues, weightG?, dimensionsMm? }`, loads the Product aggregate, validates SKU uniqueness via the repo, mutates the aggregate (`product.addVariant(...)`), persists the aggregate, then emits `catalog.variant.created`.
- A new event-publisher port `ICatalogEventPublisherPort` in `application/ports/` with one method per Stage-1 event family: `publishVariantCreated`, `publishProductPublished` (used by task-04), `publishProductArchived` (used by task-04). Define all three methods now even though task-04 wires the second and third — keeps the port stable.
- A RabbitMQ publisher adapter in `infrastructure/messaging/catalog-rabbitmq.publisher.ts` that injects the `ClientProxy` from `MicroserviceClientCatalogModule` (no — the catalog microservice **emits** events to other queues; it does not publish to its own queue). **Correction**: the catalog microservice publishes events using a `ClientProxy` bound to the default exchange / `notification_events`-style pattern. Today, every microservice uses `client.emit(routingKey, payload)` against the `ClientsModule` it imports. The catalog-microservice imports the same `MessagingModule` shape — verify by reading `apps/inventory-microservice/.../stock-rabbitmq.publisher.ts` and mirroring its `ClientProxy` injection pattern. **If** the inventory publisher emits to `MicroserviceClientNotificationModule`'s client for `notification.*` events, the catalog publisher emits to a similar client for `catalog.*` events — verify the convention before wiring.
- New routing-key constants in `libs/messaging/routing-keys.constants.ts`:
  - `CATALOG_VARIANT_CREATED = 'catalog.variant.created'`.
  - `CATALOG_PRODUCT_PUBLISHED = 'catalog.product.published'` (defined now; used by task-04).
  - `CATALOG_PRODUCT_ARCHIVED = 'catalog.product.archived'` (defined now; used by task-04).
- An `@MessagePattern` handler shell at `presentation/catalog.controller.ts` for the two write commands so the gateway can RPC them in task-06:
  - `catalog.product.register` → `RegisterProductUseCase`.
  - `catalog.variant.add` → `AddVariantUseCase`.
- Unit specs:
  - `register-product.use-case.spec.ts` — happy path + duplicate-slug-rejected.
  - `add-variant.use-case.spec.ts` — happy path + duplicate-sku-rejected + parent-not-found-rejected + emits `VariantCreated`.
- Doc deliverables: `04-catalog-use-cases.md` (write half — register + add variant) + `05-catalog-events.md` (partial — `catalog.variant.created` payload + version `v1` rationale).

**Out:**

- `Publish Product` / `Archive Product` use cases — task-04.
- The two publishing-related routing keys' actual payload + emitter — task-04 (the constants are defined here, the use cases that emit them are task-04).
- `Query Catalog` read-path RPC handlers — task-05.
- Api-gateway controller / DTOs / pipes — task-06.
- The inventory consumer for `catalog.variant.created` (auto-init `StockLevel = 0`) — `epic-04`.

## `register-product.use-case.ts` shape

```ts
@Injectable()
export class RegisterProductUseCase {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepositoryPort,
    private readonly logger: Logger,
  ) {}

  async execute(input: { name: string; slug: string; description?: string }): Promise<Product> {
    const slug = new Slug(input.slug); // throws on invalid format
    const existing = await this.products.findBySlug(slug.value);
    if (existing) throw new DuplicateSlugError(slug.value);

    const product = Product.create({ name: input.name, slug, description: input.description });
    return this.products.save(product);
  }
}
```

No event is emitted on registration — a draft Product has no business significance to other contexts until publication.

## `add-variant.use-case.ts` shape

```ts
@Injectable()
export class AddVariantUseCase {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepositoryPort,
    @Inject(CATALOG_EVENT_PUBLISHER) private readonly events: ICatalogEventPublisherPort,
    private readonly logger: Logger,
  ) {}

  async execute(input: {
    productId: number;
    sku: string;
    gtin?: string;
    optionValues: Record<string, string>;
    weightG?: number;
    dimensionsMm?: { l: number; w: number; h: number };
    correlationId: string;
  }): Promise<ProductVariant> {
    const sku = new Sku(input.sku);
    const collision = await this.products.findByVariantSku(sku.value);
    if (collision) throw new DuplicateSkuError(sku.value);

    const product = await this.products.findById(input.productId);
    if (!product) throw new ProductNotFoundError(input.productId);

    const variant = product.addVariant({ sku, gtin: input.gtin ?? null, optionValues: new OptionValues(input.optionValues), weightG: input.weightG ?? null, dimensionsMm: input.dimensionsMm ? new Dimensions(input.dimensionsMm) : null });
    const saved = await this.products.save(product);
    const persistedVariant = saved.getVariantById(variant.id) ?? variant;

    await this.events.publishVariantCreated({
      productId: product.id,
      variantId: persistedVariant.id,
      sku: sku.value,
      eventVersion: 'v1',
      correlationId: input.correlationId,
    });

    return persistedVariant;
  }
}
```

Failure modes:

- `DuplicateSkuError` — pre-check + DB unique constraint as belt-and-suspenders. The pre-check exists to surface a typed error before TypeORM's `QueryFailedError` leaks.
- `ProductNotFoundError`.
- Domain errors from `Product.addVariant`: empty `optionValues`, negative `weightG`, invalid `dimensions`, invalid `sku`. These propagate up; the gateway maps them to 400 in task-06.

## Event payloads

`catalog.variant.created` payload (`v1`):

```ts
{
  productId: number;
  variantId: number;
  sku: string;
  eventVersion: 'v1';
  correlationId: string;
}
```

Routing-key registration in `libs/messaging/routing-keys.constants.ts`:

```ts
CATALOG_VARIANT_CREATED: 'catalog.variant.created',
CATALOG_PRODUCT_PUBLISHED: 'catalog.product.published',
CATALOG_PRODUCT_ARCHIVED: 'catalog.product.archived',
```

`eventVersion: 'v1'` is the contract version (per Cross-Cutting "Event emission"). Future breaking-change events will be a new constant `CATALOG_VARIANT_CREATED_V2` rather than mutating the payload of `v1`.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/register-product.use-case.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/add-variant.use-case.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/register-product.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/add-variant.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/ports/catalog-event-publisher.port.ts` (port + `CATALOG_EVENT_PUBLISHER` token).
- `apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/catalog-rabbitmq.publisher.ts` (adapter implementing the port).
- `apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/index.ts` (barrel).
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts` (initial `@MessagePattern` handlers for the two commands; task-05 adds the read RPC handlers).
- `docs/implementation/epic-02-catalog-product-and-variant/04-catalog-use-cases.md` (write half).
- `docs/implementation/epic-02-catalog-product-and-variant/05-catalog-events.md` (partial — `variant.created` only; task-04 finishes it).

## Files to modify

- `libs/messaging/routing-keys.constants.ts` — add the three new keys.
- `libs/messaging/spec/` — extend any existing routing-key regression spec if one exists (verify by `grep -rn ROUTING_KEYS libs/messaging/spec`); otherwise add a minimal test that asserts the three new keys match the documented dotted-pattern (ADR-020).
- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` — register `RegisterProductUseCase`, `AddVariantUseCase`, the `CatalogRabbitmqPublisher` under `CATALOG_EVENT_PUBLISHER`, and the `CatalogController`. Import `MicroserviceClientCatalogModule` (or whichever client module the publisher needs — match the inventory pattern).
- The barrel `apps/catalog-microservice/src/modules/catalog/application/ports/index.ts` — export the new port + token.
- The barrel `apps/catalog-microservice/src/modules/catalog/application/use-cases/index.ts` — export the two use cases.

## Files to delete

None.

## Tests

### `register-product.use-case.spec.ts`

- **Happy path**: `findBySlug` returns `null`; `save` returns the persisted aggregate; the use case returns it with `status='draft'`.
- **Duplicate slug**: `findBySlug` returns an existing Product; the use case throws `DuplicateSlugError`; `save` is not called.
- **Invalid slug**: input slug `'Bad Slug'` throws `InvalidSlugError` from the VO constructor; no repo calls made.

### `add-variant.use-case.spec.ts`

- **Happy path**: `findByVariantSku` returns `null`; `findById` returns a Product with 0 variants; `save` returns the aggregate with one variant; `publishVariantCreated` is called once with the correct payload (including `eventVersion: 'v1'` and the input `correlationId`).
- **Duplicate SKU**: `findByVariantSku` returns an existing Product; the use case throws `DuplicateSkuError`; `findById`, `save`, and `publishVariantCreated` are not called.
- **Parent not found**: `findByVariantSku` returns `null`; `findById` returns `null`; the use case throws `ProductNotFoundError`; `save` and `publishVariantCreated` are not called.
- **Emits `VariantCreated`**: covered by the happy-path assertion above; explicitly assert the payload shape and that the routing key constant (`ROUTING_KEYS.CATALOG_VARIANT_CREATED`) is used by the adapter (the unit test mocks the port — a separate integration concern asserts the adapter sends to the right routing key; that's part of the messaging spec block).

Each spec mocks `IProductRepositoryPort` and `ICatalogEventPublisherPort`. The domain object is constructed via `Product.create(...)` directly (no DB needed for unit tests).

## Doc deliverable — `04-catalog-use-cases.md` (write half)

This task writes the **write-side half** of the doc. Target ~120 lines for the initial write-up (task-04 appends the publish/archive subsection; task-05 appends the read subsection).

Sections written by this task:

1. **Use-case shape and the Application layer convention.** Every catalog use case is a class with `execute(input): Promise<Domain>`; the constructor injects ports only (no concrete adapters). Cross-reference ADR-004 / 009.
2. **`Register Product`.** Inputs, the slug-uniqueness pre-check, why no event is emitted on draft creation.
3. **`Add Variant`.** Inputs, the SKU-uniqueness pre-check, the aggregate-root persistence path (save the parent, not the child), the `VariantCreated` emission and its `correlationId` propagation.
4. **Ports introduced.** `IProductRepositoryPort` (already in place from task-02), `ICatalogEventPublisherPort` (introduced here with three methods — only one wired in this task).
5. **The Publish/Archive subsection** is **a placeholder** with a `<!-- task-04-publish-archive-anchor -->` HTML comment that task-04 replaces. Same for the Read-path subsection (`<!-- task-05-read-path-anchor -->`).

## Doc deliverable — `05-catalog-events.md` (partial)

This task writes the routing-key registration and the `catalog.variant.created` payload. Target ~80 lines initially; task-04 finishes it. Sections written by this task:

1. **Why catalog emits events.** Other bounded contexts react to catalog state transitions: inventory auto-initialises a `StockLevel = 0` on `VariantCreated` (`epic-04`); the buyer-facing browse cache invalidates on `ProductPublished`/`ProductArchived`; the audit log subscribes to all three.
2. **Routing-key conventions.** Dotted, lowercase, `<context>.<entity>.<verb>` (ADR-020). The three constants registered in `libs/messaging/routing-keys.constants.ts`.
3. **`catalog.variant.created` payload (`v1`).** Exact field list with types and rationale (why `sku` is included even though `variantId` is the durable join key — downstream subscribers should not have to RPC back to catalog for the SKU on every consumption).
4. **Versioning.** Why `eventVersion: 'v1'` rather than version-suffixing the routing key today: keeping the suffix in the payload lets a future v2 reuse the same routing key during the rolling cutover; the constant `CATALOG_VARIANT_CREATED_V2` will be added if/when a breaking change ships.
5. **Placeholders** for the two remaining events with `<!-- task-04-publish-archive-anchor -->` comments — task-04 completes the doc.

## Carryover produced (consumed by task-04 onward)

- `RegisterProductUseCase`, `AddVariantUseCase` and their specs exist and are green.
- `ICatalogEventPublisherPort` defines all three methods; the adapter implements `publishVariantCreated` and stubs the other two with `not implemented` errors (task-04 implements them).
- Three routing-key constants registered.
- `MicroserviceClientCatalogModule` is now actively imported by the catalog publisher's adapter.
- `CatalogController` exists with two write `@MessagePattern` handlers (the gateway adapter in task-06 will RPC these).
- Docs `04-catalog-use-cases.md` (write half) and `05-catalog-events.md` (partial) exist with HTML-comment anchors marking the spots task-04 / task-05 append.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the two new use-case specs are green.
- [ ] `yarn start:dev:catalog-microservice` boots without DI resolution errors; the new `@MessagePattern` handlers are visible in startup logs.
- [ ] Manual RPC smoke from a debug REPL (or `rabbitmqadmin publish ...`) — emitting a `catalog.product.register` payload returns the persisted aggregate; emitting `catalog.variant.add` emits a `catalog.variant.created` event onto the bus (visible in `rabbitmqadmin get`).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Docs `04-catalog-use-cases.md` (write half) and `05-catalog-events.md` (partial) exist at the paths above and are filled per the section lists.
