---
epic: epic-03
task_number: 7
title: Seed + documentation pass — extend scripts/test-db-seed.ts, README, CLAUDE.md, arch-lint; author the e2e test and the currency-immutability doc
depends_on: [task-06]
doc_deliverable: docs/implementation/03-pricing-price-and-tax-category/07-currency-immutability-on-order.md
---

# Task 07 — Seed + documentation pass

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Close out the epic. Three categories of work:

1. **Seed.** Extend `scripts/test-db-seed.ts` so a fresh `yarn test:seed` produces a clean working state: three `TaxCategory` rows (`STANDARD`, `REDUCED`, `EXEMPT`), one active `USD` `Price` per seeded variant from epic-02, and the `pricing:write` permission code attached to the `admin` + `catalog-manager` roles.
2. **E2E.** Author `test/pricing.e2e-spec.ts` covering the six scenarios from the epic's "E2E tests" section plus the at-most-one-open-Price concurrency test.
3. **Documentation.** Write the final doc `07-currency-immutability-on-order.md` (the forward-looking forward-link to `epic-05`), update `README.md` (API → Catalog section, Caching note, Environment variables table), update `CLAUDE.md` (Catalog microservice section, Message patterns row, cross-module-import note), extend `spec/architecture-lint.spec.ts` with any fixtures that fell out during tasks 1–6 that are not already in place.

After this task, every exit-criterion checkbox in the epic flips green.

## Entry state assumed

Tasks 1–6 complete. Specifically:

- `pricing/` sibling module exists inside `catalog-microservice` with full domain + persistence + use cases + RPC handlers + cache-key builder.
- The publish hard-fail is live.
- The api-gateway HTTP surface is live.
- `http/pricing.http` exercises the surface end-to-end.
- Six docs (`01-` through `06-`) exist under `docs/implementation/03-pricing-price-and-tax-category/`. The seventh — `07-currency-immutability-on-order.md` — does not exist yet; this task writes it.
- The existing seed script `scripts/test-db-seed.ts` (post-epic-02 task-09) seeds an admin user, two products with two variants, and an existing role / permission registry from epic-01. The script's structure (transactional, idempotent) is already established.
- `README.md` has a Services table, an API section with a "Catalog" subsection (from epic-02 task-09), a Caching section, an Environment variables table.
- `CLAUDE.md` has a Catalog microservice section (from epic-02 task-09).
- `spec/architecture-lint.spec.ts` has the `pricing/` fixture block from task-01.

## Scope

**In:**

### Seed extension

Edit `scripts/test-db-seed.ts`:

- Insert three rows in `tax_category`: `{ code: 'STANDARD', name: 'Standard rate', description: 'Default classification — most goods.' }`, `{ code: 'REDUCED', name: 'Reduced rate', description: 'Reduced classification — e.g. food, books.' }`, `{ code: 'EXEMPT', name: 'Exempt', description: 'No tax classification — e.g. medical supplies.' }`. Insertions are idempotent — guard on `findByCode` returning null before each insert.
- Attach `STANDARD` to both seeded variants — set `product_variant.tax_category_id`. Idempotent: if the variant already has a `tax_category_id`, leave it alone.
- Insert one active `USD` `Price` per seeded variant:
  - For variant 1 (the first variant of seeded product 1): `{ currency: 'USD', amountMinor: 1999, validFrom: now, validTo: null, priority: 0 }`.
  - For variant 2 (the second variant of seeded product 1): `{ currency: 'USD', amountMinor: 2499, validFrom: now, validTo: null, priority: 0 }`.
  - Idempotent: only insert if `priceRepo.findCurrentlyOpenFor(variantId, 'USD')` returns null.
- Extend the permission registry seed (the table populated by epic-01 task-01's seed) with `pricing:write`. Idempotent: skip if the row already exists.
- Attach `pricing:write` to the `admin` role and to the `catalog-manager` role via the role_permission join table. Idempotent: skip if the join row exists.
- Make sure the order-of-operations is correct: tax categories before variant attachment, the permission registry before the role-permission attachment, and prices last (the publish precondition is now live, and a previously-seeded "published" product without prices would fail; check whether epic-02's seed leaves products in `Draft` or `Published`). **Action**: read `scripts/test-db-seed.ts` after task-06 lands; if the seed leaves seeded products in `Published`, the seed will already be failing once epic-02 task-09 runs against a database with task-04's hard rule active. Resolution: epic-02's seed must publish AFTER prices are seeded — split the seed into "seed shape" (products + variants) → "seed prices" (this task) → "seed publish" (move from epic-02's seed into this task, or have epic-02's seed call into the price seeder first). The cleanest implementation is: epic-02's seed produces `Draft` products only; this task's seed adds the prices and then publishes. **Decision**: this task adds an explicit `publishSeededProducts()` step at the end of the seed sequence. If epic-02 task-09 already published, this task removes the publish step from there and consolidates it here. Document the move in the doc deliverable + the seed script's comment header.

### E2E test

Author `test/pricing.e2e-spec.ts`. Mirror the existing `test/catalog.e2e-spec.ts` structure (from epic-02 task-09).

Scenarios (from the epic's `Test Strategy` section):

1. Admin tries to publish a Product whose variants have no Price → expect 409 with `PublishPreconditionFailedError` body. (Setup: a fresh product with variants but no prices; create it via the api during the test rather than relying on seed state.)
2. Admin Sets Prices for both variants → 200 with `PriceResponseDto`.
3. Admin publishes Product → 200, status `active`, `catalog.product.published` emitted (verify via a test consumer if epic-02 task-09 wired one; otherwise assert via the response body alone).
4. Customer (anonymous, no token) hits `GET /api/catalog/variants/:variantId/price?currency=USD` and sees the current Price.
5. Admin schedules a future Price (`validFrom = now + 1h`, `priority = 10`). Current `/price` answer unchanged. `?asOf=now+2h` returns the future Price.
6. Admin Sets a new Price now. Previous open-ended row is closed (`validTo = newPrice.validFrom`). Historic `?asOf=<close-of-the-old-price's-validity-window>` returns the OLD Price.

Add the concurrency test:

7. Spawn two `setPrice` requests within milliseconds against the same `(variantId, currency)` scope (using `Promise.all` or `supertest` parallel). Assert: both responses arrive; one succeeded with 200, the other failed with 409 `ConcurrencyError`. After both settle, exactly one row in `price` for that scope has `valid_to IS NULL`. The test reads the DB directly (via the e2e harness's TypeORM connection) to assert the invariant — do not rely on a `GET /price` to infer the state.

The test file owns its own DB cleanup hooks — `beforeAll` truncates the relevant tables (or starts a transaction that is rolled back at the end), `afterAll` releases connections. Match epic-02's e2e harness conventions.

### Documentation

`docs/implementation/03-pricing-price-and-tax-category/07-currency-immutability-on-order.md` — the forward-looking forward-link to `epic-05`. Target ~120 lines. Sections:

1. **The contract this epic ships for `Order.currency`.** Once `epic-05` lands, the cart snapshot at line-add time captures `{ variantId, currency, amountMinor }` from `SelectApplicablePriceUseCase`. The order header inherits `currency` from the first cart line; subsequent cart lines must share the same currency (or the cart write is rejected). The order's `currency` is set once at place-time and is immutable afterwards.
2. **Why this rule lives in `epic-03`, not `epic-05`.** Decision provenance: the report cited in the epic charter calls out multi-currency at the "Stage 1 threshold." The order entity in `epic-05` will inherit this rule because it is impossible to mix currencies in a single line-item snapshot — every cart line points at exactly one `Price`, and every `Price` is in exactly one currency.
3. **What "immutable on the Order header" means operationally.** A cart with a USD line cannot add an EUR line. A refund's currency follows the refund's source order. A future FX-conversion engine (Exclusions Register, `epic-15`) would compute a display value at read time; the stored value is always the place-time currency.
4. **What `epic-05` will do with this contract.** The `Cart` aggregate will have a `currency: string | null` field; `null` until the first line is added; set on first-add; subsequent adds assert equality. The `Order` aggregate's `currency` is set in the `place()` method from the cart's resolved value.
5. **What `epic-15` reserves.** The discussion of multi-channel pricing, customer-group pricing, B2B contract pricing, dynamic pricing — all of which interact with the currency immutability rule and are deferred.
6. **A small ASCII diagram** of the data flow: `Set Price → Price.currency` → `Cart.addLine → snapshot Price → CartLine.currency` → `Cart.place → Order.currency`. (Plain text; no graphical assets.)
7. **Open questions for the `epic-05` team.** Three: (a) what happens if `Set Price` runs between two `Cart.addLine` calls — does the second line snapshot the new price or the old? (Answer: the second line snapshots whatever `SelectApplicablePriceUseCase` returns at the moment of the addLine call; the first line is unaffected. Both lines are immutable.) (b) Does a price `validTo` close affect a pre-existing cart line? (No — the snapshot is immutable; only future cart writes are affected.) (c) What about a "rebate at place-time" model? (Deferred to `epic-15`.)

### `README.md` updates

- **API → Catalog section**: add a "Catalog → Pricing" subsection listing the six new endpoints (one row per endpoint, mirroring the rows for the existing catalog endpoints). Cite the controller path.
- **Caching section, "What is NOT cached"**: add a bullet stating that pricing reads are deliberately uncached at the walking-skeleton stage; the cache-key builder `catalogPrice*` exists for the future wire-up; the threshold for switching to cache-aside is documented in `docs/implementation/03-pricing-price-and-tax-category/05-select-applicable-price.md`.
- **Environment variables table**: add a row for `DEFAULT_CURRENCY` (default `USD`, used by `Publish Product` precondition and by the api-gateway's `/price` default).
- **Services table** (if exists): no change — `catalog-microservice` already has a row; pricing is a sibling module.
- **System diagram** (if exists in ASCII or referenced as an asset): no change — the message bus topology is unchanged (the new routing keys ride the existing `catalog_queue`).

### `CLAUDE.md` updates

- **Catalog microservice section**: extend the file-listing snippet (the inline tree of `apps/catalog-microservice/src/modules/`) to include the `pricing/` sibling module beside `catalog/`. Match the existing indentation / tree-art style.
- **Message patterns list**: add a row for `catalog.price.changed` (emitted by `Set Price`) and one for `catalog.price.scheduled` (emitted by `Schedule Price`). Include the payload version (`v1`) and the producing use case.
- **Forbidden-import note**: under the catalog section, add a bullet: "`pricing/domain/**` must not import from `catalog/**`, and vice-versa. The two modules communicate via the variant id (FK in persistence; opaque value in the domain). The `eslint-plugin-boundaries` rule + the `spec/architecture-lint.spec.ts` fixtures enforce this."
- **Documentation pointer**: add a one-line link to `docs/implementation/03-pricing-price-and-tax-category/` from the catalog section.

### `spec/architecture-lint.spec.ts` extension

If tasks 1–6 introduced any new directory whose boundaries are not captured by the existing fixture set, add a fixture. Concretely:

- Verify the `CatalogPortsModule` (if extracted in task-04) is governed by the same boundaries as the rest of the catalog `infrastructure/` tree.
- Verify the cross-module-import ban catches a synthetic import of `catalog/domain/*` from `pricing/domain/*` and the reverse. The task-01 fixture block already covers the latter; verify both directions are tested.
- If the gateway's catalog module gained a new sub-tree (`presentation/catalog-pricing.controller.ts` if task-05 split the controller), add a fixture for it.

The spec is regression coverage — it does not run domain logic. Each new fixture is a 5-line block.

### Final pass: tmp/ references audit

Run, before merging:

```bash
grep -rn "tmp/" docs/ apps/ libs/ http/ scripts/ spec/ README.md CLAUDE.md
```

Expected output: no matches. If any match exists, fix it before closing the task. The self-containment rule in the epic is the final gate.

**Out:**

- Any new endpoints or domain logic — tasks 1–6.
- Discount / promotion / FX engine — `epic-15`.
- Audit-store consumer for `catalog.price.changed` — `epic-11`.

## Files to add

- `docs/implementation/03-pricing-price-and-tax-category/07-currency-immutability-on-order.md`.
- `test/pricing.e2e-spec.ts`.

## Files to modify

- `scripts/test-db-seed.ts` — three new seed steps (tax categories, prices, role-permission) + the publish step relocation if needed.
- `README.md` — API → Catalog pricing subsection, Caching note, Environment variables row.
- `CLAUDE.md` — catalog microservice section extension, message patterns list, forbidden-import note, doc pointer.
- `spec/architecture-lint.spec.ts` — any missing fixtures discovered during tasks 1–6.
- Any incidental file the audit-pass turns up that references `tmp/`.

## Files to delete

None.

## Tests

The e2e spec authored here is the only new test. Unit specs from earlier tasks remain authoritative.

The exit criterion for this task — and for the epic as a whole — is that `yarn test:unit` AND `yarn test:e2e` AND the manual `http/pricing.http` flow all pass on a clean checkout + `docker compose up -d && yarn migration:run && yarn start:dev && yarn test:seed`.

## Doc deliverable

`docs/implementation/03-pricing-price-and-tax-category/07-currency-immutability-on-order.md`. Content per §"Documentation" above.

## Carryover produced

This is the final task — the carryover is the entire delivered epic. Concretely:

- Seed produces a working pricing demo state.
- E2E asserts every endpoint + the publish hard-fail + the concurrency invariant.
- README + CLAUDE.md document the surface for future contributors.
- Arch-lint catches regressions in the cross-module-import ban.
- Doc 07 lays the contract `epic-05` will inherit.

## Exit criteria (cumulative — closes the epic)

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the full set of ≥5 new pricing spec files (from tasks 2 + 3) + the updated `publish-product.use-case.spec.ts` (from task-04) is green.
- [ ] `yarn test:e2e` passes; `test/pricing.e2e-spec.ts` is green, including the concurrency scenario.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev && yarn test:seed` boots clean. The seed produces three tax categories, two USD prices, the `pricing:write` permission attached to roles, and the two seeded products `Published`.
- [ ] Every request in `http/pricing.http` executes end-to-end against the seeded data with the documented status codes.
- [ ] `GET /api/catalog/variants/:variantId/price?currency=USD` returns the seeded Price for both seeded variants.
- [ ] At-most-one-`validTo IS NULL`-per-`(variantId, currency)` invariant is asserted by the concurrency e2e test against the live MySQL.
- [ ] All seven per-task docs exist under `docs/implementation/03-pricing-price-and-tax-category/`:
  - `01-pricing-module-scaffold.md`
  - `02-price-domain-and-append-only-history.md`
  - `03-tax-category-and-variant-attachment.md`
  - `04-publish-precondition-hard-fail.md`
  - `05-select-applicable-price.md`
  - `06-pricing-api-and-kulala.md` (both halves)
  - `07-currency-immutability-on-order.md`
- [ ] `README.md` API → Catalog section, Caching section, Environment variables table all reflect the pricing surface.
- [ ] `CLAUDE.md` catalog microservice section lists the `pricing/` sibling module, the two new routing keys, and the cross-module-import ban.
- [ ] `grep -rn "tmp/" docs/ apps/ libs/ http/ scripts/ spec/ README.md CLAUDE.md` produces no matches.
- [ ] The epic's `Exit Criteria` checklist (in `tmp/epics/epic-03-pricing-price-and-tax-category.md`) is fully checked.
