---
epic: epic-03
task_number: 1
title: Scaffold the pricing module + clear the superseded publish-price placeholder
depends_on: []
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/01-pricing-module-scaffold.md
adr_deliverable: none
---

# Task 01 — Scaffold the pricing module + clear the superseded publish-price placeholder

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

For this task the most relevant ADRs are **ADR-004 / ADR-009 / ADR-012 / ADR-013**
(per-module hexagonal layout), **ADR-017** (architecture lint via
`eslint-plugin-boundaries`), **ADR-018** (NestJS monorepo), **ADR-024** (the
`PermissionCodeEnum` registry is the single source of truth for permission
codes), and **ADR-025** (the catalog aggregate — its publish use case carries
the placeholder this task removes).

## Goal

Stand up an empty-but-bootable `pricing` **sibling module** inside
`catalog-microservice` (the canonical per-module hexagonal skeleton:
`domain / application / infrastructure / presentation`), wired into the service's
composition root so the service still boots and `yarn lint` still passes. In the
same session, remove the obsolete *warn-and-proceed* publish-price placeholder
the catalog inherited (it is being superseded by a real hard-fail later), extend
the permission registry with the `pricing:write` code (keeping the seed
consistent), and add the architecture-lint regression fixtures that lock the new
module to the same boundaries every other module obeys.

This is the **cleanup-first task**: pricing is purely additive to the schema, so
the single obsolete artifact is the publish-price placeholder. It is **deleted
here, never renamed**, and the references the removal leaves dangling are fixed
in this same task.

## Entry state assumed

- The catalog product/variant capability is complete and on disk:
  `apps/catalog-microservice/src/modules/catalog/` holds the `Product` aggregate,
  persistence, four write + three read use cases, the event publisher, and the
  controller. The service boots as an RMQ server on `catalog_queue` with a live
  MySQL connection (`apps/catalog-microservice/src/app/app.module.ts` calls
  `DatabaseModule.forRoot(catalogEntities)`).
- `apps/catalog-microservice/src/modules/` contains exactly one module folder,
  `catalog/`. No `pricing/` folder exists yet.
- `PublishProductUseCase`
  (`apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts`)
  contains a warn-and-proceed seam: an inline comment about a future pricing
  capability plus a `this.logger.warn(..., 'active price precondition not yet
  enforced — pricing capability pending')` call. Its spec
  (`.../spec/publish-product.use-case.spec.ts`) has a test
  `'warns that the active-price precondition is deferred and still proceeds'`.
- `libs/contracts/auth/permission.enum.ts` declares 12 codes; the highest seed
  id in `scripts/test-db-seed.ts` `PERMISSION_SEEDS` is
  `00000000-0000-4000-b000-00000000000c` (`audit:read`). `seedRoles` builds the
  `admin` role from `Object.values(PermissionCodeEnum)` and resolves each code's
  id from `PERMISSION_SEEDS` — **adding an enum value without a matching
  `PERMISSION_SEEDS` row throws `seedRoles: missing permission id for code …`**.
- `eslint.config.mjs` classifies every `apps/*/src/modules/*/<layer>/**` path
  automatically via the generic boundaries element patterns — a new sibling
  module needs **no** `eslint.config.mjs` change.
- `spec/architecture-lint.spec.ts` has a `describe('boundaries/dependencies —
  catalog microservice', …)` block with the catalog module's regression
  fixtures.

## Scope

**In**
- Create the `pricing` module skeleton + a minimal, bootable `PricingModule`
  wired into `app.module.ts`.
- Add `PermissionCodeEnum.PRICING_WRITE = 'pricing:write'` + its `PERMISSION_SEEDS`
  row + bind it to the `catalog-manager` role (admin inherits it via
  `Object.values`). Keep the seed idempotent and non-throwing.
- Delete the warn-and-proceed publish-price placeholder from
  `PublishProductUseCase` and its spec, and fix the dangling references.
- Add `pricing`-module architecture-lint regression fixtures.
- Write `01-pricing-module-scaffold.md`.

**Out**
- Any `Price` / `TaxCategory` domain model, entity, or migration (task-02).
- Any pricing use case, event, routing key, or controller handler (task-03 / 04).
- The real publish hard-fail enforcement (task-05) — this task only removes the
  placeholder; it does **not** add a price check.
- Gateway endpoints, the `.http` file, the price/tax seed rows (task-06 / 07 / 08).

## Module skeleton to create

Mirror the catalog module's per-module hexagonal shape (ADR-004/025), including
its one divergence — the Nest module file sits at the module root, not under
`infrastructure/`:

```
apps/catalog-microservice/src/modules/pricing/
  domain/                       # (Price, TaxCategory, VOs, events — task-02/03)
  application/
    ports/                      # (repository + events publisher ports — task-02/03)
    use-cases/                  # (Set/Schedule/Select + tax use cases — task-03/04)
  infrastructure/
    persistence/                # (entities, mappers, repository — task-02)
    messaging/                  # (events publisher — task-03)
  presentation/                 # (PricingController @MessagePattern — task-03/04)
  pricing.module.ts             # module root (mirrors catalog.module.ts location)
  index.ts                      # barrel: export { PricingModule }, export const pricingEntities
```

- Keep folders that have no files yet alive with a barrel `index.ts` (git does
  not track empty directories). A barrel that re-exports nothing yet is fine — it
  is excluded from the boundaries graph (`**/index.ts` is ignored).
- `pricing.module.ts` is a minimal, valid Nest module this session:
  `@Module({})` with a header comment that providers, the `forFeature` entities,
  the controller, and the `MicroserviceClientCatalogModule` import arrive with the
  pricing domain/use cases. Do not import an empty `DatabaseModule.forFeature([])`.
- `index.ts` (module root) exports `PricingModule` and
  `export const pricingEntities = [] as const;` (typed as an entity array; task-02
  appends `PriceEntity` / `TaxCategoryEntity`). This is the seam `app.module.ts`
  consumes — established now, populated later.

## Permission registry change (keep the seed consistent)

`libs/contracts/auth/permission.enum.ts` — append:

```ts
  PRICING_WRITE = 'pricing:write',
```

(matches the existing `^[a-z][a-z-]*:[a-z][a-z-]*$` shape).

`scripts/test-db-seed.ts`:
- Add a `PERMISSION_SEEDS` row: `{ id: '00000000-0000-4000-b000-00000000000d',
  code: PermissionCodeEnum.PRICING_WRITE, description: 'Set or schedule prices and
  manage tax categories' }`.
- Add `PermissionCodeEnum.PRICING_WRITE` to the `catalog-manager` role's
  `permissions` array (the `admin` role already covers it via
  `Object.values(PermissionCodeEnum)` — do **not** also list it explicitly there).
- The seed must remain idempotent (`INSERT IGNORE` paths) and must not throw.

## Cleanup — delete the publish-price placeholder

In `apps/catalog-microservice/src/modules/catalog/application/use-cases/publish-product.use-case.ts`:
- Remove the pricing-precondition seam: the multi-line `// Pricing precondition
  seam …` comment **and** the `this.logger.warn({ correlationId, productId },
  'active price precondition not yet enforced — pricing capability pending')`
  call. Leave the `product.publish()` domain transition (the ≥1-variant rule),
  the persistence, the event drain, and the best-effort publish untouched.

In `.../spec/publish-product.use-case.spec.ts`:
- Delete the `it('warns that the active-price precondition is deferred and still
  proceeds', …)` test entirely. The remaining tests (happy publish + emit;
  rejects no-variant; rejects not-found; best-effort publish failure) stay green.

Fix the references the removal leaves dangling (do **not** leave a stale
"warns-and-proceeds" claim in any deliverable):
- `CLAUDE.md` — the `catalog.product.publish` message-pattern line currently ends
  `… domain enforces ≥1 variant; the "≥1 active Price" precondition
  warns-and-proceeds until a pricing capability lands)`. Reduce it to describe the
  current state: `… domain enforces ≥1 variant; the active-Price publish
  precondition is owned by the pricing capability)`.
- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md` —
  the passages describing the publish precondition as a "deferred warn-not-block
  seam" (and the matching note in `03-product-and-variant-domain.md`) now describe
  removed code. Rewrite them so they state that `publish()` enforces the
  ≥1-variant rule and that the active-Price publish precondition is owned by the
  pricing capability (no warn placeholder). Describe by capability, never by an
  epic/task number.

> Do **not** touch `docs/adr/025-…md`: an accepted ADR is immutable except for a
> status line (ADR-003). Its forward-looking discussion of the price precondition
> is a historical record; the new decision is recorded in ADR-026 (task-02) and
> realized in task-05.

## Architecture-lint fixtures

In `spec/architecture-lint.spec.ts`, add a `describe('boundaries/dependencies —
pricing module', …)` block that mirrors the catalog block, pointed at
`apps/catalog-microservice/src/modules/pricing/<layer>/__fixture__.ts` virtual
paths (the generic element patterns classify them automatically — the target
files need not exist for the external-denylist cases):

- `pricing domain may not import @nestjs/common` (import `Injectable`).
- `pricing domain may not import typeorm` (import `EntityManager`).
- `pricing application use-case may not import typeorm`.
- `pricing application use-case may not import @nestjs/typeorm`.
- `pricing application port may not import typeorm`.
- `pricing presentation may not import @retail-inventory-system/database`.
- **Cross-module bumper** — `pricing domain may not import the catalog module's
  domain`: inject `import { Product } from
  '../../catalog/domain/product.model';` at a `pricing/domain/__fixture__.ts` path
  and assert `boundaries/dependencies` fires (this resolves to a real file, so it
  proves the pricing↔catalog domain isolation the epic mandates — communication is
  via the opaque `variantId`, never a cross-module domain import).

Keep the inlined `ELEMENTS` / `DEPENDENCY_RULES` in the spec mirrored with
`eslint.config.mjs` — do not weaken either (ADR-017).

## Files to add

- `apps/catalog-microservice/src/modules/pricing/pricing.module.ts`
- `apps/catalog-microservice/src/modules/pricing/index.ts`
- `apps/catalog-microservice/src/modules/pricing/domain/index.ts`
- `apps/catalog-microservice/src/modules/pricing/application/ports/index.ts`
- `apps/catalog-microservice/src/modules/pricing/application/use-cases/index.ts`
- `apps/catalog-microservice/src/modules/pricing/infrastructure/persistence/index.ts`
- `apps/catalog-microservice/src/modules/pricing/infrastructure/messaging/index.ts`
- `apps/catalog-microservice/src/modules/pricing/presentation/index.ts`
- `docs/implementation/03-pricing-price-and-tax-category/01-pricing-module-scaffold.md`

## Files to modify

- `apps/catalog-microservice/src/app/app.module.ts` — import `PricingModule`;
  spread `pricingEntities` into `DatabaseModule.forRoot([...catalogEntities,
  ...pricingEntities])`.
- `libs/contracts/auth/permission.enum.ts` — add `PRICING_WRITE`.
- `scripts/test-db-seed.ts` — add the permission seed row + `catalog-manager`
  binding.
- `apps/catalog-microservice/.../catalog/application/use-cases/publish-product.use-case.ts`
  — remove the placeholder seam.
- `apps/catalog-microservice/.../catalog/application/use-cases/spec/publish-product.use-case.spec.ts`
  — remove the `'warns…'` test.
- `spec/architecture-lint.spec.ts` — add the pricing-module fixtures.
- `CLAUDE.md` — adjust the `catalog.product.publish` line.
- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md`
  and `03-product-and-variant-domain.md` — rewrite the warn-not-block passages.

## Files to delete

None — the cleanup is the deletion of code *within* the publish use case and its
spec (above), not whole files.

## Tests

- **Unit:** `yarn test:unit` stays green; `publish-product.use-case.spec.ts` now
  has one fewer test and no remaining reference to the warn placeholder.
- **Architecture-lint:** the new `pricing module` fixtures fail-as-expected
  (each asserts `boundaries/dependencies` fires); the spec passes under
  `yarn test:unit`.
- **No new e2e** in this task. `yarn test:e2e` must still pass unchanged (the
  seed gains one permission row + one role binding and must remain idempotent).
- **`scripts/test-db-seed.ts`:** re-running `yarn test:seed` twice must not error
  or duplicate rows; assert manually that the `admin` and `catalog-manager` roles
  resolve `pricing:write` without the `missing permission id` throw.

## Doc deliverable

`docs/implementation/03-pricing-price-and-tax-category/01-pricing-module-scaffold.md`
— outline:
- **Why a sibling module, not a new microservice** — pricing colocates with the
  catalog bounded context; `variantId` is the shared backbone key (ADR-025);
  RPCs ride the existing `catalog_queue`.
- **The per-module hexagonal skeleton** — the four layers + the module-root
  `pricing.module.ts` divergence; what each folder will hold.
- **Boundaries** — pricing obeys the same generic `apps/*/src/modules/*` lint
  rules with no config change; the pricing↔catalog domain isolation (communicate
  via the opaque `variantId`, never a cross-module domain import) and the
  regression fixture that locks it.
- **The `pricing:write` permission code** — added to the `PermissionCodeEnum`
  single source of truth (ADR-024); seeded to `admin` + `catalog-manager`; the
  enum↔seed coupling that forces the `PERMISSION_SEEDS` row to land together.
- **Removing the publish-price placeholder** — what the warn-and-proceed seam
  was, why it is deleted now (not renamed), and that the real precondition
  enforcement is owned by the pricing capability and lands separately.

## Carryover to read

None — first task.

## Carryover to produce

Write `tmp/tasks/epic-03-pricing-price-and-tax-category/carryover-01.md` per
`tmp/tasks/execution-requirements.md` §7. Capture at minimum:
- **Entry state for task-02:** the `pricing` module skeleton paths that now
  exist; that `pricingEntities` is an empty exported array consumed by
  `app.module.ts`; that `PricingModule` is a minimal `@Module({})` with no
  providers yet.
- **Files added / modified / deleted** (concise list).
- **Key decisions:** the `pricing:write` enum value + its seed id
  (`…-b000-…00d`) + the `catalog-manager` binding; that the publish use case now
  enforces only the ≥1-variant rule (no price awareness); that no
  `eslint.config.mjs` change was needed; the cross-module isolation fixture
  added.
- **Known gaps / deferrals:** the real publish hard-fail is owned by task-05; the
  `Price`/`TaxCategory` domain + entities + migration by task-02; routing keys +
  use cases by task-03/04.
- **How to verify:** `yarn lint`, `yarn test:unit`, `yarn test:e2e`,
  `yarn build`, the self-containment grep, and that
  `docker compose up -d && yarn migration:run && yarn start:dev` still boots the
  catalog service.

## Exit criteria

- [ ] `apps/catalog-microservice/src/modules/pricing/` skeleton + `PricingModule`
      exist; `app.module.ts` imports `PricingModule` and spreads `pricingEntities`.
- [ ] `yarn build` and `yarn start:dev` boot the catalog service clean (RMQ on
      `catalog_queue`, live MySQL connection).
- [ ] `PermissionCodeEnum.PRICING_WRITE` exists; the seed resolves it for `admin`
      + `catalog-manager` with no `missing permission id` throw; the seed is
      idempotent.
- [ ] The warn-and-proceed publish-price placeholder is gone from the use case
      and its spec; no deliverable claims the precondition "warns-and-proceeds".
- [ ] The `pricing module` architecture-lint fixtures pass (each asserts the
      boundary fires), including the pricing↔catalog domain cross-module bumper.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes.
- [ ] `yarn test:e2e` passes.
- [ ] `01-pricing-module-scaffold.md` is written.
- [ ] The self-containment grep is clean
      (`grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`).
- [ ] `carryover-01.md` is written.
