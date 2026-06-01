---
epic: epic-02
task_number: 4
title: Implement Publish Product + Archive Product use cases and complete the events doc
depends_on: [task-01, task-02, task-03]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/05-catalog-events.md
---

# Task 04 — `Publish Product` + `Archive Product` use cases

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Wire the two state-transition write operations against the existing `Product` aggregate. `Publish Product` flips `draft → active` and emits `catalog.product.published`; `Archive Product` flips `active → archived` and emits `catalog.product.archived`. Both use cases call the existing `ICatalogEventPublisherPort` introduced in task-03; this task implements the two emitter methods that task-03 stubbed.

The Price precondition for publish (per Cross-Cutting: "≥1 active Price") is **not** enforced as a hard error in this epic — `epic-03` adds it. Task-04's use case logs a warning and proceeds. The "≥1 variant" precondition **is** enforced as a hard error today (it's a model-layer invariant set in task-02; the use case just lets the model error propagate).

## Entry state assumed

Tasks 1–3 carryover present:

- `RegisterProductUseCase` and `AddVariantUseCase` exist; `catalog.variant.created` event is emitted on Add Variant.
- `ICatalogEventPublisherPort` defines three methods; the adapter implements `publishVariantCreated` and throws `not implemented` for the other two — this task replaces the two throws with real implementations.
- Routing-key constants `CATALOG_PRODUCT_PUBLISHED` and `CATALOG_PRODUCT_ARCHIVED` are registered in `libs/messaging/routing-keys.constants.ts`.
- `Product.publish()` and `Product.archive()` are model methods with the state-machine invariants already enforced; this task only adds the application orchestration around them.
- `docs/implementation/02-catalog-product-and-variant/04-catalog-use-cases.md` has a `<!-- task-04-publish-archive-anchor -->` HTML comment awaiting replacement.
- `docs/implementation/02-catalog-product-and-variant/05-catalog-events.md` has a `<!-- task-04-publish-archive-anchor -->` HTML comment awaiting replacement.

## Scope

**In:**

- Two use cases under `apps/catalog-microservice/src/modules/catalog/application/use-cases/`:
  - `publish-product.use-case.ts` — loads the Product, calls `product.publish()`, persists it, emits `catalog.product.published`. Logs a warning (not an error) if the product has no Price record — but **today, pricing data lives in a different bounded context that doesn't yet exist** (`epic-03`); the warning is implemented as a deliberate no-op TODO comment that references `epic-03`, not as an actual price lookup. Spec asserts the TODO comment exists.
  - `archive-product.use-case.ts` — loads the Product, calls `product.archive()`, persists it, emits `catalog.product.archived`.
- Real implementations for `ICatalogEventPublisherPort.publishProductPublished` and `publishProductArchived` in `catalog-rabbitmq.publisher.ts` (replacing the task-03 `not implemented` stubs).
- Two new `@MessagePattern` handlers on `presentation/catalog.controller.ts`:
  - `catalog.product.publish` → `PublishProductUseCase`.
  - `catalog.product.archive` → `ArchiveProductUseCase`.
- Unit specs:
  - `publish-product.use-case.spec.ts` — happy path + no-variants-rejected + already-active-rejected + emits `ProductPublished`.
  - `archive-product.use-case.spec.ts` — happy path + not-active-rejected + emits `ProductArchived`.
- Doc deliverable: complete `05-catalog-events.md` (replace the task-04 anchor with the two new payload sections). Also append the publish/archive subsection to `04-catalog-use-cases.md` (replace its task-04 anchor).

**Out:**

- Hard enforcement of "≥1 active Price" — `epic-03`.
- `Reclassify Product` (Category attach/detach) — `epic-06`.
- Any read-path code — task-05.
- Api-gateway HTTP endpoints (`POST /api/catalog/products/:id/publish` etc.) — task-06.

## `publish-product.use-case.ts` shape

```ts
@Injectable()
export class PublishProductUseCase {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepositoryPort,
    @Inject(CATALOG_EVENT_PUBLISHER) private readonly events: ICatalogEventPublisherPort,
    @InjectPinoLogger(PublishProductUseCase.name) private readonly logger: PinoLogger,
  ) {}

  async execute(input: { productId: number; correlationId: string }): Promise<Product> {
    const product = await this.products.findById(input.productId);
    if (!product) throw new ProductNotFoundError(input.productId);

    // TODO(epic-03): once Price + TaxCategory land, look up active Prices for
    // every variant and reject (or downgrade to draft) if any is missing.
    // Until then, log a warning and proceed.
    this.logger.warn({ productId: product.id, epic: 'epic-03' }, 'Publish path: Price precondition not yet enforced');

    product.publish(); // throws ProductHasNoVariantsError / InvalidProductStatusTransitionError

    const saved = await this.products.save(product);

    await this.events.publishProductPublished({
      productId: saved.id,
      slug: saved.slug.value,
      variantIds: saved.variants.map((v) => v.id),
      publishedAt: saved.updatedAt.toISOString(),
      eventVersion: 'v1',
      correlationId: input.correlationId,
    });

    return saved;
  }
}
```

## `archive-product.use-case.ts` shape

```ts
@Injectable()
export class ArchiveProductUseCase {
  constructor(
    @Inject(PRODUCT_REPOSITORY) private readonly products: IProductRepositoryPort,
    @Inject(CATALOG_EVENT_PUBLISHER) private readonly events: ICatalogEventPublisherPort,
    @InjectPinoLogger(ArchiveProductUseCase.name) private readonly logger: PinoLogger,
  ) {}

  async execute(input: { productId: number; correlationId: string }): Promise<Product> {
    const product = await this.products.findById(input.productId);
    if (!product) throw new ProductNotFoundError(input.productId);

    product.archive(); // throws InvalidProductStatusTransitionError if !active

    const saved = await this.products.save(product);

    await this.events.publishProductArchived({
      productId: saved.id,
      archivedAt: saved.updatedAt.toISOString(),
      eventVersion: 'v1',
      correlationId: input.correlationId,
    });

    return saved;
  }
}
```

## Event payloads (the two new ones)

`catalog.product.published` (`v1`):

```ts
{
  productId: number;
  slug: string;
  variantIds: number[];
  publishedAt: string; // ISO-8601
  eventVersion: 'v1';
  correlationId: string;
}
```

`catalog.product.archived` (`v1`):

```ts
{
  productId: number;
  archivedAt: string; // ISO-8601
  eventVersion: 'v1';
  correlationId: string;
}
```

The `publishedAt` / `archivedAt` fields come from the persisted aggregate's `updatedAt`, not from `new Date()` — the source of truth is the row's update timestamp. Spec asserts this.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/archive-product.use-case.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/archive-product.use-case.spec.ts`.

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/infrastructure/messaging/catalog-rabbitmq.publisher.ts` — implement `publishProductPublished` and `publishProductArchived` (replace the `not implemented` throws from task-03). Each uses `client.emit(ROUTING_KEYS.CATALOG_PRODUCT_PUBLISHED, payload)` / `CATALOG_PRODUCT_ARCHIVED`.
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts` — add two `@MessagePattern` handlers (`catalog.product.publish`, `catalog.product.archive`).
- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` — register `PublishProductUseCase` and `ArchiveProductUseCase` as providers.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/index.ts` — barrel re-export.
- `docs/implementation/02-catalog-product-and-variant/04-catalog-use-cases.md` — replace `<!-- task-04-publish-archive-anchor -->` with the publish/archive subsection.
- `docs/implementation/02-catalog-product-and-variant/05-catalog-events.md` — replace `<!-- task-04-publish-archive-anchor -->` with the two new payload sections (full doc complete after this task).

## Files to delete

None.

## Tests

### `publish-product.use-case.spec.ts`

- **Happy path**: `findById` returns a draft Product with one variant; `save` returns it as active; the use case calls `publishProductPublished` with the correct payload (assert `variantIds` and `publishedAt` matches `saved.updatedAt.toISOString()`). The "Price precondition warning" log is asserted via a logger mock — the use case must call `logger.warn(...)` with a payload containing `epic: 'epic-03'`.
- **No-variants-rejected**: `findById` returns a draft Product with `variants=[]`; `product.publish()` throws `ProductHasNoVariantsError`; `save` and `publishProductPublished` are not called.
- **Already-active**: `findById` returns an active Product; `product.publish()` throws `InvalidProductStatusTransitionError`; `save` and `publishProductPublished` are not called.
- **Product-not-found**: `findById` returns `null`; throws `ProductNotFoundError`; no further calls.

### `archive-product.use-case.spec.ts`

- **Happy path**: `findById` returns an active Product; `save` returns it as archived; `publishProductArchived` is called with the correct payload.
- **Not-active**: `findById` returns a draft Product; `product.archive()` throws `InvalidProductStatusTransitionError`; `save` and `publishProductArchived` are not called.
- **Already-archived**: `findById` returns an archived Product; same behaviour as above.
- **Product-not-found**: same shape as in the publish spec.

## Doc deliverable — `05-catalog-events.md` (complete)

Replace the `<!-- task-04-publish-archive-anchor -->` placeholder with two new subsections — one per event. For each event:

- **Payload (`v1`)** — exact field list with types.
- **Emission trigger** — the use case that emits it; the routing-key constant.
- **Idempotency note** — emitting `catalog.product.published` twice (e.g. RabbitMQ redelivery before the consumer acks) must be safe for downstream consumers. Catalog itself is idempotent at the emission point only if the state transition has already happened; otherwise the second call throws `InvalidProductStatusTransitionError`. Downstream consumers (inventory in `epic-04`) are responsible for handling duplicate deliveries.
- **Downstream subscribers known to exist or planned** — the inventory consumer for `catalog.variant.created` (`epic-04`); the audit-log subscriber (`epic-11`).

After the two subsections, add a brief **Section: "Why dotted routing keys"** citing ADR-020 — uniform with the other contexts already on the bus.

## Doc deliverable — `04-catalog-use-cases.md` append (publish/archive half)

Replace the `<!-- task-04-publish-archive-anchor -->` with:

1. **`Publish Product`.** Inputs (just `productId` + correlationId from the request scope); the state-machine guard; the deliberate-non-enforcement of the Price precondition; the emission of `ProductPublished`; the `publishedAt` source-of-truth note.
2. **`Archive Product`.** Inputs; the state-machine guard; the emission of `ProductArchived`. Cross-Cutting reference to "Soft delete vs hard delete" — archived rows remain referenceable forever; the path is not deletion.
3. **What this subsection did NOT do.** Cross-reference to `epic-03` (the Price precondition becomes an error there), `epic-06` (`Reclassify Product` — Category attach), and task-05 of this epic (read-path RPC handlers).

## Carryover produced (consumed by task-05 onward)

- All four write use cases exist: Register, AddVariant, Publish, Archive.
- All three Stage-1 events (`variant.created`, `product.published`, `product.archived`) are emitted by their respective use cases.
- `catalog.controller.ts` has four `@MessagePattern` write handlers; task-05 adds the read handlers.
- Doc `05-catalog-events.md` is complete.
- Doc `04-catalog-use-cases.md` has its write half complete; task-05 appends the read half.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the two new use-case specs are green.
- [ ] `yarn start:dev:catalog-microservice` boots; the two new `@MessagePattern` handlers are registered.
- [ ] Manual RPC smoke from a debug REPL: emitting `catalog.product.publish` for a draft Product with ≥1 variant returns the active aggregate and emits `catalog.product.published` on the bus; emitting it for a draft with 0 variants returns a typed error envelope.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `05-catalog-events.md` is complete (no remaining `<!-- task-04-… -->` anchors).
- [ ] Doc `04-catalog-use-cases.md` has its task-04 anchor replaced; the task-05 anchor remains.
