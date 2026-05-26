---
epic: epic-02
task_number: 9
title: Seed + documentation pass — extend test seed, README, CLAUDE.md, arch-lint fixtures
depends_on: [task-01, task-02, task-03, task-04, task-05, task-06, task-07, task-08]
doc_deliverable: —
---

# Task 09 — Seed + documentation pass

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing.

## Goal

Close out the epic. Extend `scripts/test-db-seed.ts` so the seeded DB carries the catalog permissions, the `catalog-manager` role binding, and two example Products with two Variants each (so the next epics can address them by id without re-seeding). Bring `README.md`, `CLAUDE.md`, and `spec/architecture-lint.spec.ts` in sync with the new microservice. Flip the `xit` markers introduced by task-06 (permission-failure e2e blocks) and task-07 (disabled http blocks) back to `it` now that the seed supports them.

This is a cumulative pass. Every task before this one has produced its own carryover artifacts (entities, migrations, use cases, controllers, docs); this task assembles the "outside" view — what the human reader sees in the project's top-level docs and what CI exercises.

## Entry state assumed

Tasks 1–8 carryover present:

- `catalog-microservice` is live, boots, owns the `catalog_product` + `catalog_variant` tables, emits three events on the bus, exposes seven `@MessagePattern` handlers.
- The api-gateway has `modules/catalog/` with seven HTTP endpoints, gated per the permission matrix from task-06.
- `http/catalog.http` exists with permission-failure blocks tagged `### DISABLED — requires task-09 seed`.
- `test/catalog.e2e-spec.ts` has `xit`-marked permission-failure blocks with `TODO(task-09)` comments.
- The obsolete inventory `product` table is dropped (task-08).
- `scripts/test-db-seed.ts` still seeds only the `epic-01` shape (StaffUsers + Customer + the 12 permission codes + the 4 canonical roles; the `catalog:read/write/publish` codes already exist in the registry but are not yet bound to a `catalog-manager` role).

## Scope

**In:**

- Extend `scripts/test-db-seed.ts`:
  - Seed the `catalog-manager` role if not already present (`epic-01`'s task-01 seeds it). Bind it to the three catalog permission codes (`catalog:read`, `catalog:write`, `catalog:publish`).
  - Seed a `catalog-manager` StaffUser (`catalog@example.com`, password `catalog1234`). Assign it the `catalog-manager` role.
  - Seed a `warehouse-staff` StaffUser (`warehouse@example.com`, password `warehouse1234`). Assign it the `warehouse-staff` role (no catalog permissions). This user is the negative-case fixture for the permission-failure tests.
  - Seed two example Products in the new `catalog_product` table:
    - Product 1: name `"Classic Cotton Tee"`, slug `"classic-cotton-tee"`, status `active`. Two variants: `TEE-RED-S` (`{color: red, size: S}`, weight 180g) and `TEE-BLUE-M` (`{color: blue, size: M}`, no weight).
    - Product 2: name `"Heavyweight Hoodie"`, slug `"heavyweight-hoodie"`, status `active`. Two variants: `HOOD-BLACK-L` (`{color: black, size: L}`, weight 720g) and `HOOD-GREY-XL` (`{color: grey, size: XL}`, weight 740g).
  - All seed operations are idempotent (re-running `yarn seed` is a no-op).
- Update `README.md`:
  - Add a `catalog-microservice` row to the Services table (description, port-less, queue `catalog_queue`).
  - Update the System diagram (ASCII or Mermaid) to include the catalog box, its queue, and the three new routing keys (`catalog.product.published`, `catalog.product.archived`, `catalog.variant.created`).
  - Add **API → Catalog** section listing the seven endpoints (mirroring the existing **API → Retail** / **API → Inventory** sections).
  - Add a caption (or a footnote) noting "every downstream cluster keys on `variantId` (not `productId`) — see `epic-02` and `epic-04` for the cutover rationale".
- Update `CLAUDE.md`:
  - Add `apps/catalog-microservice/` to the Architecture section's app tree.
  - Add a new section **Catalog microservice (`apps/catalog-microservice/src/`)** mirroring the per-module template documentation block (modeled on the existing notification + inventory + retail sections).
  - Add the new routing keys to the **Message patterns** list (or table).
  - Update the **Shared Libraries → messaging** description to mention `MicroserviceClientCatalogModule`.
- Extend `spec/architecture-lint.spec.ts`:
  - The task-01 fixture extension proved the new app's tree is governed by the standard boundaries rules. This task adds one or two regression fixtures that specifically exercise the catalog tree — e.g. a fixture under `apps/catalog-microservice/src/modules/catalog/domain/` that illegally imports from `infrastructure/`, asserting `boundaries/element-types` reports it. The point is that future refactors to `eslint.config.mjs` cannot silently weaken the catalog boundaries.
- Flip task-06's `xit` markers in `test/catalog.e2e-spec.ts` to `it` for the permission-failure blocks now that `catalog@example.com` and `warehouse@example.com` are seeded. Remove the `TODO(task-09)` comments.
- Flip task-07's `### DISABLED` markers in `http/catalog.http` to active `###` blocks for the `nonCatalogStaffLogin` / `registerProductForbidden` flow. Remove the disabled markers.

**Out:**

- Any change to the catalog-microservice's domain or use-case code — all of that is locked by tasks 02–05.
- Any new endpoint or routing key — those are locked by tasks 03–06.
- The Exclusions Register (`epic-15`) — this epic owns none.
- `epic-04`'s inventory rewiring — task-08 left the dangling FK comment in place; it stays there.

## Doc copy guidance

### README — System diagram

If the existing diagram is ASCII, extend it. Concrete addition:

```
                 +----------------+
                 |  catalog svc   |  (rmq: catalog_queue)
                 +----------------+
                          ^
                          |  events:
                          |   catalog.variant.created
                          |   catalog.product.published
                          |   catalog.product.archived
                          v
                  +----------------+
                  |  api-gateway   |
                  +----------------+
```

If the existing diagram is Mermaid, add a `catalog-microservice` node with the same three event labels.

### README — API → Catalog section

Mirror the API → Retail section. Include the seven endpoints in the same table shape (`Method`, `Path`, `Auth`, `Notes`). Notes should call out:

- `catalog:write` vs. `catalog:publish` distinction.
- `@Public()` on the GET endpoints (no bearer required).
- The `?status=` filter on `GET /api/catalog/products` (default `active`; passing `archived` is reserved for an admin-only future flag — today the controller hard-codes `active` and ignores the parameter; flag this if you want to expose archived-list later).

### CLAUDE.md — Catalog microservice section

Mirror the notification-microservice section. Include:

- The boot file (`apps/catalog-microservice/src/main.ts` opens with `import './otel.setup';`).
- The module tree (`modules/catalog/{domain,application,infrastructure,presentation}`).
- The seven `@MessagePattern` handlers.
- The three events.
- The persistence shape (`catalog_product` + `catalog_variant`, FK direction, no `@VersionColumn`).
- The cross-context coupling notes from the epic (epic-03 owns Price; epic-04 owns the inventory consumer for `VariantCreated`; epic-06 owns Category).

## Files to add

- (none new; this task is a polish pass)

## Files to modify

- `scripts/test-db-seed.ts` — extend per "Scope" above.
- `README.md` — Services table, System diagram, API → Catalog section, caption.
- `CLAUDE.md` — app tree, new section, Message patterns list, messaging description.
- `spec/architecture-lint.spec.ts` — extend with 1–2 catalog-specific fixtures.
- `test/catalog.e2e-spec.ts` — flip `xit` → `it`, remove `TODO(task-09)` comments.
- `http/catalog.http` — flip `### DISABLED` → `###`, remove disabled markers.

## Files to delete

None.

## Tests

- The catalog e2e block from task-06 now runs in full (no `xit` markers).
- `yarn test:unit` — no new specs.
- `yarn test:e2e` — full green:
  - Catalog admin flow (register → variants → publish → list → get-by-slug → get-variant → archive).
  - Permission gates: `catalog@example.com` can register / publish / archive; `warehouse@example.com` gets 403 on every write; unauthenticated requests get 200 on every GET; 403 on every POST.
  - `epic-01`'s e2e (auth, IAM) still passes — the seed extension is additive.
- The arch-lint spec extension is green.

## Doc deliverable

None new. The task's documentation work is README + CLAUDE.md + the polish on the existing seven per-task docs (verify each is complete, no stray `<!-- task-… -->` anchors remain).

## Carryover produced

- The seeded DB carries the full catalog fixture set: 4 roles, 12 permissions, 4 staff users (admin, catalog-manager, warehouse-staff, plus the epic-01 ones), 1 customer, 2 products with 2 variants each.
- README + CLAUDE.md reflect the new microservice.
- The e2e suite covers the full catalog flow + permission matrix without any `xit`.
- `http/catalog.http` runs all blocks without disabled markers.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; all spec files (across all five apps + libs) are green.
- [ ] `yarn test:e2e` passes; `test/catalog.e2e-spec.ts` runs all blocks; existing `epic-01` e2es still pass.
- [ ] `yarn seed` is idempotent — running it twice produces no errors, no duplicate rows, and the same set of seeded Products + Variants.
- [ ] `docker compose up -d && yarn migration:run && yarn seed && yarn start:dev` boots all five services; `curl http://localhost:3000/api/catalog/products` returns the two seeded Products with their Variants.
- [ ] Every endpoint in `http/catalog.http` (including the previously-disabled permission-failure blocks) executes end-to-end against the seeded data.
- [ ] All seven per-task docs under `docs/implementation/epic-02-catalog-product-and-variant/` exist and contain no stray `<!-- task-… -->` HTML-comment anchors.
- [ ] `README.md` Services table + System diagram + API section reflect the catalog microservice; `CLAUDE.md` includes the new Catalog microservice section.
- [ ] No file outside `tmp/` references `tmp/`.
