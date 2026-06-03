# Carryover 01 — Scaffold the pricing module + clear the publish-price placeholder

State handed forward from task-01 to task-02 (and beyond). Read this before
touching the pricing module.

## Entry state for task-02

- A new **sibling module** `pricing` lives inside `catalog-microservice` at
  `apps/catalog-microservice/src/modules/pricing/`, with the canonical four-layer
  hexagonal skeleton on disk:
  - `domain/index.ts`
  - `application/ports/index.ts`
  - `application/use-cases/index.ts`
  - `infrastructure/persistence/index.ts`
  - `infrastructure/messaging/index.ts`
  - `presentation/index.ts`
  - `pricing.module.ts` (module root, mirrors `catalog.module.ts`'s location)
  - `index.ts` (module-root barrel)
  Every folder-level barrel is an intentionally empty ES module (`export {};` +
  a header comment) — they exist only to keep the directory tracked by git and
  to let the generic boundaries lint classify future files automatically.
- `PricingModule` is a minimal **empty `@Module({})`** — no providers, no
  controller, no `forFeature`, no imports yet. It is wired into the service
  composition root: `app/app.module.ts` imports `PricingModule` and registers
  `DatabaseModule.forRoot([...(catalogEntities as typeof pricingEntities), ...pricingEntities])`.
- `pricingEntities` is an **empty exported array** declared in the module-root
  `index.ts` as `export const pricingEntities: EntityClassOrSchema[] = [];`. This
  is the persistence seam `app.module.ts` already consumes. **task-02 appends
  `PriceEntity` / `TaxCategoryEntity` to this array** (and adds the migration that
  creates the tables) — no `app.module.ts` change is needed when it does.
  - NOTE: unlike catalog (where `catalogEntities` is re-exported from
    `infrastructure/persistence/index.ts`), pricing declares `pricingEntities`
    directly in the **module-root** `index.ts`. task-02 may either keep it there
    importing the entities from `./infrastructure/persistence`, or relocate the
    declaration to mirror catalog — either is fine; just keep the module-root
    `index.ts` re-exporting it so `app.module.ts`'s import is unchanged.
- The catalog service still boots clean as an RMQ server on `catalog_queue` with
  a live MySQL connection (verified — see "How to verify").

## Files added

- `apps/catalog-microservice/src/modules/pricing/pricing.module.ts`
- `apps/catalog-microservice/src/modules/pricing/index.ts`
- `apps/catalog-microservice/src/modules/pricing/domain/index.ts`
- `apps/catalog-microservice/src/modules/pricing/application/ports/index.ts`
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/index.ts`
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/index.ts`
- `apps/catalog-microservice/src/modules/pricing/infrastructure/messaging/index.ts`
- `apps/catalog-microservice/src/modules/pricing/presentation/index.ts`
- `docs/implementation/03-pricing-price-and-tax-category/01-pricing-module-scaffold.md`
- `tmp/tasks/epic-03-pricing-price-and-tax-category/carryover-01.md` (this file)

## Files modified

- `apps/catalog-microservice/src/app/app.module.ts` — import `PricingModule`;
  spread `pricingEntities` into the single `DatabaseModule.forRoot(...)`.
- `libs/contracts/auth/permission.enum.ts` — appended
  `PRICING_WRITE = 'pricing:write'`.
- `scripts/test-db-seed.ts` — added the `PERMISSION_SEEDS` row (`…-b000-…00d`) and
  the `catalog-manager` role binding for `pricing:write`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts`
  — removed the warn-and-proceed publish-price placeholder (comment + `logger.warn`).
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts`
  — removed the `'warns that the active-price precondition is deferred…'` test.
- `spec/architecture-lint.spec.ts` — added the
  `boundaries/dependencies — pricing module` fixture block (7 cases, incl. the
  pricing↔catalog domain cross-module bumper).
- `CLAUDE.md` — adjusted the `catalog.product.publish` message-pattern line; noted
  the sibling pricing scaffold module + the combined `forRoot` in the catalog
  service section.
- `README.md` — added `pricing:write` to the `catalog-manager` role row and a new
  `pricing:write` row in the permissions table.
- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md` and
  `03-product-and-variant-domain.md` — rewrote the publish-price "warn-not-block"
  passages to "owned by the pricing capability".

## Files deleted

- None. (The cleanup was the deletion of code *within* the publish use case and
  its spec, not whole files.)

## Key decisions & deviations

- **`pricing:write` enum value + seed id.** `PermissionCodeEnum.PRICING_WRITE =
  'pricing:write'`; seed row id `00000000-0000-4000-b000-00000000000d` (continues
  the `…-b000-…` permission UUID namespace after `audit:read` at `…000c`);
  description `'Set or schedule prices and manage tax categories'`. Bound to the
  **`catalog-manager`** role explicitly; `admin` inherits it via
  `Object.values(PermissionCodeEnum)` (NOT listed explicitly under admin). Verified
  in the DB: both roles resolve `pricing:write` with exactly one
  `role_permissions` row each, no `missing permission id` throw.
- **The publish use case is now price-unaware.** `PublishProductUseCase` enforces
  only the ≥1-variant rule (delegated to `Product.publish()`). There is no price
  check, no warn, no deferred seam in catalog. The active-Price publish
  precondition is described as **owned by the pricing capability**.
- **No `eslint.config.mjs` change was needed** — the generic
  `apps/*/src/modules/*/<layer>/**` element patterns classify the pricing layers
  automatically. The spec's inlined `ELEMENTS` / `DEPENDENCY_RULES` were left
  untouched; only fixture test cases were added.
- **`app.module.ts` spread cast.** `catalogEntities` is typed
  `TypeOrmModuleOptions['entities']` — a `MixedList` (array OR object map OR
  `undefined`) that cannot be spread under `strictNullChecks`. It is cast to
  `typeof pricingEntities` (`EntityClassOrSchema[]`) to merge both halves. If
  task-02 wants this cleaner, it could retype `catalogEntities` to
  `EntityClassOrSchema[]` (also lets `catalog.module.ts`'s `forFeature` use it
  directly), but that was out of scope here.
- **ADR-026 is NOT yet written.** The task naming reserves ADR-026 for the
  pricing domain decision (task-02). The next free ADR number is **026**. ADR-025
  was left untouched (immutable historical record; its forward-looking price
  discussion stays as-is).

## Known gaps / deferrals (each owned by a later task)

- **`Price` / `TaxCategory` domain + entities + migration** → task-02 (also writes
  ADR-026 and appends to `pricingEntities`).
- **Price use cases + events + routing keys** → task-03.
- **Tax-category use cases + variant attachment** → task-04.
- **The real publish hard-fail** (publish blocks a price-less product) → task-05.
  task-01 only *removed* the placeholder; it did **not** add any price check.
- **Gateway pricing endpoints** → task-06; **`http/pricing.http`** → task-07;
  **price/tax seed rows + finalization** → task-08.

## How to verify (all run green at end of task-01)

- `yarn lint` — exit 0 (`--max-warnings 0`).
- `yarn test:unit` — 393 tests / 57 suites pass (publish-product spec has one
  fewer test; `spec/architecture-lint.spec.ts` pricing fixtures pass).
- `yarn build` — exit 0 (the `app.module.ts` spread type-checks).
- `yarn test:e2e` — 75 tests / 6 suites pass on a fresh infra reload + migrate +
  seed.
- Seed idempotency — `yarn test:seed` run twice: both print
  `✓ Database seeded successfully`, no duplicate rows.
- Self-containment grep clean:
  `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`
  → no orchestration references.
- Catalog service boots: with infra up,
  `node dist/apps/catalog-microservice/main.js` (env from `.env.local`) logs
  `Catalog Microservice is listening for messages` and runs `SELECT version()`
  against MySQL — clean, no errors. (`docker compose up -d && yarn migration:run
  && yarn start:dev` is the dev-mode equivalent.)
