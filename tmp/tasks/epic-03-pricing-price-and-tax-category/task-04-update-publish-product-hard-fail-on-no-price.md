---
epic: epic-03
task_number: 4
title: Update Publish Product to hard-fail when any variant lacks an active Price in DEFAULT_CURRENCY
depends_on: [task-03]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/04-publish-precondition-hard-fail.md
---

# Task 04 — Update `Publish Product` to hard-fail on missing active Price

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Convert the deferred precondition from epic-02 task-04 — a logged warning of the form "publish proceeded but variants lack a Price" — into a hard rule. After this task, `Publish Product` rejects with a domain error (mapped to `409 Conflict` at the gateway) if any variant attached to the product does not have an active `Price` in the `DEFAULT_CURRENCY` (env var, default `USD`) at the moment of the publish attempt. This is the first cross-module dependency wired in the epic: the catalog module's `PublishProductUseCase` injects `SelectApplicablePriceUseCase` from the pricing module via its exported provider.

This task is small in lines-of-code but architecturally load-bearing — it is the first place where one sibling module reaches across the cross-module boundary into another. The discipline established here (port-level dependency, no domain-level coupling) is the template every subsequent cross-module call in later epics will follow.

## Entry state assumed

Task-03 complete. Specifically:

- `SelectApplicablePriceUseCase` exists under `apps/catalog-microservice/src/modules/pricing/application/use-cases/` and is exported from `PricingModule`.
- The pricing repo + clock + event publisher are wired and tested.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts` carries the epic-02 implementation: it validates "≥1 variant exists" as a hard rule and logs a TODO-marked warning when any variant has no price (the placeholder code path the doc cites is the literal `console.warn(`Variant ${variant.id} has no active Price; publish proceeded.`)` or whatever the epic-02 task-04 spec specifies — `grep` for the warning string to find the exact line).
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts` asserts the warning path with a logger spy.
- The catalog `PublishProductUseCase` is exposed via `@MessagePattern(CATALOG_PRODUCT_PUBLISH)` already; the api-gateway already has `POST /api/catalog/products/:productId/publish`.

## Scope

**In:**

- Modify `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts`:
  - Inject `SelectApplicablePriceUseCase` (cross-module). The constructor signature grows by one parameter; the `CatalogModule` providers list grows by one import statement.
  - Read `DEFAULT_CURRENCY` from `process.env.DEFAULT_CURRENCY ?? 'USD'`. Read it once at use-case instantiation (constructor) via the existing `ConfigService` if epic-02 wired one; otherwise read at execute-time. Match the existing config-access pattern in `catalog-microservice`. **Action**: `grep -rn 'ConfigService' apps/catalog-microservice/src` first to see how other use cases pull env values; clone that pattern.
  - For each variant on the product, call `selectApplicablePrice.execute({ variantId: v.id, currency: DEFAULT_CURRENCY })`. The call is made inside the publish transaction so that the "no price" decision is read against the same snapshot the publish will commit against.
  - If any variant returns `null`, throw `PublishPreconditionFailedError(productId, variantIdsMissingPrice, currency)`. The error carries the list of variant ids that lacked a price so the gateway can surface a useful body to the caller. Do not throw on the first missing — collect all variants without a price (cheap, since the variant set is small) and report once. **Tradeoff**: a single round-trip per variant is the simplest implementation; a batched `findApplicableMany` would be a future optimisation but is not justified at the current scale.
  - Remove the warning log + the TODO comment from the epic-02 implementation. The doc deliverable documents the deletion (so a future reviewer searching for the TODO understands where it went).
- Modify `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts`:
  - Import `PricingModule` (the entire module, not just the use case — Nest module-scope dependency).
  - Add `PricingModule` to the `imports:` array of `CatalogModule`. Because `PricingModule.exports` only re-exports `SelectApplicablePriceUseCase` (plus the repository / clock ports — see task-02), `CatalogModule` only gains that one symbol; it does not gain visibility into pricing's domain models. The boundaries lint from task-01 enforces this: catalog/`domain/**` may not import from `pricing/domain/**`.
  - **The cross-module dependency is asymmetric.** `CatalogModule` imports `PricingModule`, not the other way around. Verify there is no cycle: `PricingModule` does not import `CatalogModule` even though task-03's `AttachTaxCategoryToVariantUseCase` injects `ProductVariantRepositoryPort` — task-03 documents that the port lives in `catalog/application/ports/` and is exported by `CatalogModule`. **Action**: confirm `CatalogModule.exports` includes `PRODUCT_VARIANT_REPOSITORY_PORT` before this task ships; if not, add it as a one-line edit in this task. The order of edits matters: do not introduce a circular module dependency. **A circular module dependency in NestJS is silent at build time and crashes at boot with a confusing message; the fix is `forwardRef()`. The simpler fix is to design the cycle out.** The design above has no cycle: `CatalogModule.imports = [PricingModule]`; `PricingModule.imports = [CatalogModule]` would be the cycle. Task-03 should already be doing this without importing CatalogModule into PricingModule — it injects the port via the `CatalogModule`'s exports, but the port lives in a separate Nest module-scope only if it has been registered there. The standard NestJS resolution is: `CatalogModule` is in the global module imports of `app.module.ts`, and the port is exported from `CatalogModule` to whoever imports `CatalogModule`. `PricingModule` imports `CatalogModule` to get the port. This IS a cycle if `CatalogModule` then imports `PricingModule`. **Resolution**: extract the `ProductVariantRepositoryPort` registration into a small `CatalogPortsModule` that both `CatalogModule` and `PricingModule` import, and that has no other dependencies. Document this in the doc deliverable.
  - Alternative (simpler if the epic-02 layout permits): use `forwardRef(() => PricingModule)` and `forwardRef(() => CatalogModule)` on the two cyclical imports. The downside is that `forwardRef` is a code smell — it papers over a circular dependency that should be designed out. The doc weighs both choices and recommends the `CatalogPortsModule` extraction.
- Update `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts`:
  - Replace the "warning is logged when no price" assertion with "throws `PublishPreconditionFailedError` when any variant lacks a price."
  - Add a fixture: variant A has a `USD` price, variant B does not → the error names variant B and only variant B.
  - Add a fixture: all variants have a `USD` price → publishes successfully (and emits `catalog.product.published`).
  - The clock and the price repo are both faked via in-memory implementations of their ports.
- Define `PublishPreconditionFailedError` in the catalog domain layer (`apps/catalog-microservice/src/modules/catalog/domain/`). If the catalog domain already has a `DomainError` hierarchy, extend it; otherwise the existing pattern from epic-02 task-04 is the template.
- Add an `.env` / `.env.example` entry for `DEFAULT_CURRENCY=USD` if `catalog-microservice` carries one (epic-02 introduced the env-file shape — clone it).
- Add `DEFAULT_CURRENCY` to `docker-compose.yml`'s `catalog-microservice` env block so the containerised microservice picks the value up.
- Doc deliverable `04-publish-precondition-hard-fail.md`.

**Out:**

- The api-gateway side of the mapping (how `PublishPreconditionFailedError` becomes `409 Conflict` in the HTTP response) — the gateway already maps domain errors via an exception filter from epic-01 / epic-02; verify the new error type is recognised; only add a one-line mapping entry if the filter uses an explicit allowlist. If the filter falls back to `500 Internal Server Error` for unknown error types, add an entry. **Action**: `grep -rn 'HttpExceptionFilter\|domain-error.filter' apps/api-gateway/src` to find the filter; document the resolution.
- The e2e test that asserts the 409 path — lives in `test/pricing.e2e-spec.ts` (task-07).
- Any change to `Archive Product`, `Register Product`, or `Add Variant`.

## `PublishPreconditionFailedError` shape

```ts
// apps/catalog-microservice/src/modules/catalog/domain/publish-precondition-failed.error.ts
export class PublishPreconditionFailedError extends DomainError {
  constructor(
    public readonly productId: number,
    public readonly variantIdsMissingPrice: readonly number[],
    public readonly currency: string,
  ) {
    super(
      `Cannot publish product ${productId}: variants ${variantIdsMissingPrice.join(', ')} ` +
      `have no active Price in ${currency}.`,
    );
  }
}
```

The structured fields (`productId`, `variantIdsMissingPrice`, `currency`) feed the gateway's response body; the gateway formats them into a JSON body shape that matches the existing error envelope (epic-01 established the envelope; reuse).

## Why 409, not 422

The epic defers the choice to the doc deliverable; the recommendation is:

- **409 Conflict** — the resource is in a state that conflicts with the requested operation. "Publish requires ≥1 Price per variant; the variants are not yet priced; the conflict is with the resource's current state, not the request payload's syntactic correctness." This is the recommended code.
- **422 Unprocessable Entity** — the request was syntactically valid but semantically rejected. Slightly weaker fit: the request payload here is empty (just `productId` in the path); there is nothing about the payload that is unprocessable. The state-conflict reading is cleaner.
- **400 Bad Request** — too generic; not used.

**Decision**: 409. Document the alternatives and the trade-off so a future contributor revisiting the choice has the rationale to hand.

## Algorithm — full pseudocode

```ts
async execute({ productId }: { productId: number }): Promise<Product> {
  const product = await this.productRepo.findById(productId);
  if (!product) throw new NotFoundError(`Product ${productId}`);
  if (product.status === ProductStatus.Published) return product; // idempotent

  const variants = await this.variantRepo.findByProductId(productId);
  if (variants.length === 0) {
    throw new PublishPreconditionFailedError(productId, [], this.defaultCurrency);
  }

  const missing: number[] = [];
  for (const v of variants) {
    const p = await this.selectApplicablePrice.execute({
      variantId: v.id,
      currency: this.defaultCurrency,
    });
    if (p === null) missing.push(v.id);
  }
  if (missing.length > 0) {
    throw new PublishPreconditionFailedError(productId, missing, this.defaultCurrency);
  }

  product.publish(this.clock);
  await this.productRepo.save(product);
  await this.eventPublisher.publishProductPublished({ productId, eventVersion: 'v1', correlationId });

  return product;
}
```

Note the `if (variants.length === 0)` branch reuses the same error type to surface the precondition failure with an empty `variantIdsMissingPrice` array — the message string handles the degenerate case ("variants  have no active Price"). **Tradeoff**: the empty-variants case is currently a separate `DomainError` in epic-02's implementation (no variants ≠ no prices). Keep epic-02's existing "no variants" error; only handle "no prices" with the new error. **Decision**: keep the two errors distinct — no-variants is a structural failure ("this product has no shape to publish"), no-prices is an attachment failure ("this product has shape but no money is attached"). Update pseudocode accordingly in the implementation; the doc records the distinction.

Corrected pseudocode:

```ts
if (variants.length === 0) throw new NoVariantsToPublishError(productId);  // epic-02's existing error
const missing = …
if (missing.length > 0) throw new PublishPreconditionFailedError(productId, missing, defaultCurrency);
```

## Module cycle resolution

The `CatalogModule ↔ PricingModule` cycle deserves a small section in the doc. Concrete plan:

- Create `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog-ports.module.ts`:

  ```ts
  @Module({
    imports: [TypeOrmModule.forFeature([ProductEntity, ProductVariantEntity])],
    providers: [
      { provide: PRODUCT_REPOSITORY_PORT, useClass: ProductTypeormRepository },
      { provide: PRODUCT_VARIANT_REPOSITORY_PORT, useClass: ProductVariantTypeormRepository },
    ],
    exports: [PRODUCT_REPOSITORY_PORT, PRODUCT_VARIANT_REPOSITORY_PORT],
  })
  export class CatalogPortsModule {}
  ```

- `CatalogModule.imports = [CatalogPortsModule, PricingModule, …]`.
- `PricingModule.imports = [CatalogPortsModule, …]` (NOT `CatalogModule`).

This breaks the cycle: both modules import a leaf `CatalogPortsModule` whose only job is to register the catalog persistence ports. No `forwardRef()` needed.

If task-02 / task-03 already factored the catalog persistence wiring this way, this section is a no-op and the doc records the discovery. If not, this task does the extraction.

## Tests

Updates to the existing spec (`publish-product.use-case.spec.ts`):

- Delete the assertion that the logger was called for the "no price" warning.
- Add three fixtures:
  - All variants priced → publishes; logger is not called; event is emitted.
  - One variant of three not priced → throws `PublishPreconditionFailedError`; the error's `variantIdsMissingPrice` is exactly the one missing variant's id; event is NOT emitted; the product status remains `Draft`.
  - All variants of three not priced → throws `PublishPreconditionFailedError`; the error's `variantIdsMissingPrice` is all three ids.
- The fake `SelectApplicablePriceUseCase` is wired with a small in-memory map `{ [variantId]: Price | null }` so each fixture seeds its own price-coverage state.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/domain/publish-precondition-failed.error.ts`.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog-ports.module.ts` (only if the cycle resolution requires it — see above).
- `docs/implementation/03-pricing-price-and-tax-category/04-publish-precondition-hard-fail.md`.

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts` — inject `SelectApplicablePriceUseCase`, add the missing-price check, throw the new error, delete the warning log + TODO.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts` — drop the warning assertion, add the three new fixtures.
- `apps/catalog-microservice/src/modules/catalog/infrastructure/catalog.module.ts` — adjust `imports:` to break the cycle (per the resolution chosen) and ensure `CatalogModule` can see `SelectApplicablePriceUseCase`.
- `apps/catalog-microservice/src/modules/pricing/infrastructure/pricing.module.ts` — adjust `imports:` to import `CatalogPortsModule` (or `forwardRef(() => CatalogModule)` per the resolution chosen).
- `docker-compose.yml` — add `DEFAULT_CURRENCY: USD` to the `catalog-microservice` env block.
- `.env.example` (if exists) — add `DEFAULT_CURRENCY=USD`. If no example file exists at the repo root, leave to task-07's README update to introduce.
- `apps/api-gateway/src/...` — only if the existing exception filter does not already translate the new domain error. **Verify first**, modify only if required.

## Files to delete

None.

## Doc deliverable

Write `docs/implementation/03-pricing-price-and-tax-category/04-publish-precondition-hard-fail.md`. Target ~150 lines. Sections:

1. **What changed.** The warning is gone; the hard-fail is in. Diff-level pointer to the deleted TODO so a future contributor searching for it understands the history.
2. **The `DEFAULT_CURRENCY` env.** Why an env, not a hard-coded constant. Why `USD` is the default. How to override per-deployment (cite where it lives in `docker-compose.yml` and `.env.example`). Note: this is the **only** currency the publish precondition checks against; multi-currency catalogs are still allowed (a variant can have prices in EUR + USD), but if `DEFAULT_CURRENCY=USD` then the USD price is what gates publish. Document the tradeoff: a market-first deployment (say, EUR-primary) would set `DEFAULT_CURRENCY=EUR` and the precondition flips. Forward-link: `epic-15` may introduce a per-market scope.
3. **Why 409 Conflict.** The reasoning. The two alternatives (422, 400). The decision.
4. **The cross-module wiring.** The `CatalogModule ↔ PricingModule` cycle, the `CatalogPortsModule` extraction (or whatever resolution lands), and the rule of thumb: persistence ports are leaf modules; use cases sit on top.
5. **The error shape, as a contract.** `PublishPreconditionFailedError` carries `productId`, `variantIdsMissingPrice`, `currency`. The gateway response body. Sample JSON. The api-gateway exception filter mapping path.
6. **Idempotency.** A second publish call (when the product is already `Published`) is a no-op. The hard-fail does NOT regress this — only the not-yet-published path runs the precondition check.
7. **What this does NOT change.** `Archive Product` still archives a published product without re-checking prices (a published product was already gated; an archived product is no longer publicly visible, so the precondition is moot). `Add Variant` does not require a price at creation time (a price-less variant is a legal transient state — it just blocks publish).
8. **Forward-looking notes.** The audit-store consumer in `epic-11` sees `catalog.product.published` after the precondition passes — meaning a published product is implicitly priced. Downstream `epic-05` cart can therefore assume any published product has a price (in the default currency).

## Carryover produced (consumed by task-05 onward)

- `Publish Product` is now a real hard rule. Task-05's gateway endpoint surfaces it as 409.
- `DEFAULT_CURRENCY` is present in env wiring; task-07's seed reuses the same value when seeding prices for the existing epic-02 variants.
- The cross-module wiring pattern (port-only) is established and documented; later epics that need to cross modules within `catalog-microservice` follow this template.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the updated `publish-product.use-case.spec.ts` is green with the three new fixtures; the warning assertion is gone.
- [ ] `yarn build:catalog-microservice` succeeds; boot is clean (no `Nest can't resolve dependencies` or `CIRCULAR_DEPENDENCY` errors).
- [ ] `docker compose up -d` boots `catalog-microservice` with `DEFAULT_CURRENCY=USD` in its env.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `04-publish-precondition-hard-fail.md` exists at the path above and is filled per the section list.
