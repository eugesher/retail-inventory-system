---
epic: epic-03
source_epic_file: tmp/epics/epic-03-pricing-price-and-tax-category.md
---

# epic-03 — Task Index

This epic is decomposed into **8 self-contained tasks**, each sized for a single
cold-start session. Every task file states its **entry state** (what prior tasks
left on disk and in the `retail_db` schema), the **concrete files** it
adds/modifies/deletes, the **tests** it must write, its **doc deliverable**, and
its **exit criteria**. A task assumes nothing about future tasks; it relies only
on the repository as committed by prior tasks plus the `carryover-*.md` notes in
this folder. Run them strictly in order — there is no parallelism.

The capability delivered: a money layer colocated with the catalog. A new
`pricing` sibling module inside `catalog-microservice` owns `Price` (a
currency-scoped, time-bounded, append-only-for-history ledger) and `TaxCategory`
(a classification label only — actual rates stay external). Set Price, Schedule
Price, and Select Applicable Price give downstream cart/order lines a
deterministic `(variantId, currency, asOf)` → price answer. The catalog's
publish path turns the previously deferred "≥1 active Price" precondition into a
hard rule.

## Sequence and dependencies

| # | Task | Touches | Doc deliverable |
|---|---|---|---|
| 1 | [Scaffold the pricing module + clear the superseded publish-price placeholder](task-01-scaffold-pricing-module-and-cleanup.md) | `apps/catalog-microservice/src/modules/pricing/` (skeleton), `apps/catalog-microservice/src/app/app.module.ts`, `apps/catalog-microservice/.../catalog/application/use-cases/publish-product.use-case.ts` (+ spec), `libs/contracts/auth/permission.enum.ts`, `scripts/test-db-seed.ts`, `spec/architecture-lint.spec.ts`, `CLAUDE.md` (publish line) | `01-pricing-module-scaffold.md` |
| 2 | [Price + TaxCategory domain, persistence, repository, migration](task-02-price-and-tax-category-domain-and-persistence.md) | `apps/catalog-microservice/src/modules/pricing/{domain,application/ports,infrastructure/persistence}/`, `migrations/` | `02-price-domain-and-append-only-history.md` + `03-tax-category-and-variant-attachment.md` (domain/persistence half) + **ADR-026** |
| 3 | [Set / Schedule / Select Applicable Price use cases + events](task-03-price-use-cases-and-events.md) | `apps/catalog-microservice/src/modules/pricing/{application/use-cases,infrastructure/messaging,presentation}/`, `apps/catalog-microservice/.../pricing/pricing.module.ts`, `libs/messaging/routing-keys.constants.ts`, `libs/contracts/microservices/microservice-message-pattern.enum.ts`, `libs/contracts/catalog/`, `libs/cache/cache-keys.ts` | `05-select-applicable-price.md` |
| 4 | [TaxCategory use cases + variant attachment](task-04-tax-category-use-cases-and-variant-attachment.md) | `apps/catalog-microservice/src/modules/pricing/{application/use-cases,presentation}/`, `apps/catalog-microservice/.../pricing/pricing.module.ts`, `libs/messaging/routing-keys.constants.ts`, `libs/contracts/microservices/microservice-message-pattern.enum.ts`, `libs/contracts/catalog/` | `03-tax-category-and-variant-attachment.md` (use-case half) |
| 5 | [Publish Product hard-fails on a missing active Price](task-05-publish-precondition-hard-fail.md) | `apps/catalog-microservice/.../catalog/application/use-cases/publish-product.use-case.ts` (+ spec), `apps/catalog-microservice/.../catalog/` ports/wiring, `libs/config/` (`DEFAULT_CURRENCY`), `CLAUDE.md`, `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md` | `04-publish-precondition-hard-fail.md` |
| 6 | [API-gateway pricing + tax-category endpoints](task-06-api-gateway-pricing-endpoints.md) | `apps/api-gateway/src/modules/catalog/{application,infrastructure/messaging,presentation}/`, `test/pricing.e2e-spec.ts` | `06-pricing-api-and-kulala.md` (API half) |
| 7 | [Kulala `http/pricing.http`](task-07-kulala-pricing-http-file.md) | `http/pricing.http` | `06-pricing-api-and-kulala.md` (Kulala half) |
| 8 | [Seed + docs + lint-fixtures finalization](task-08-seed-docs-and-finalization.md) | `scripts/seeds/`, `scripts/utils/test-db-seed.util.ts`, `README.md`, `CLAUDE.md`, `spec/architecture-lint.spec.ts` | `07-currency-immutability-on-order.md` (+ README / CLAUDE) |

## Carryover chain

Each task `NN` ends by writing `carryover-NN.md` in this folder. Each task `N`
begins by reading **every** prior `carryover-01.md … carryover-(N-1).md` in
order. The carryover files are the only transition markers and live only under
this folder — never in source, docs, `README.md`, or `CLAUDE.md`. Do the tasks
in order; do not parallelize.

## Document-deliverable map

Implementation docs live under `docs/implementation/03-pricing-price-and-tax-category/`.
Each task writes its own doc(s) **as part of its Definition of Done** (a task is
not complete until its doc explains the what and why). Two docs are written
across two tasks each — the later task completes the doc, it does not back-fill
from scratch.

| Doc | Written by |
|---|---|
| `01-pricing-module-scaffold.md` | task-01 |
| `02-price-domain-and-append-only-history.md` | task-02 |
| `03-tax-category-and-variant-attachment.md` | task-02 (domain/persistence) → task-04 (use cases + variant attach) |
| `04-publish-precondition-hard-fail.md` | task-05 |
| `05-select-applicable-price.md` | task-03 |
| `06-pricing-api-and-kulala.md` | task-06 (API/read-path) → task-07 (Kulala flow) |
| `07-currency-immutability-on-order.md` | task-08 |

**ADR:** task-02 records **ADR-026** (`docs/adr/026-price-append-only-ledger-and-tax-category.md`)
— the `Price` append-only-for-history ledger, the `(variantId, currency)` scope,
the closed/open interval model + Select Applicable resolution, the at-most-one
open-row invariant and how it is enforced, and `TaxCategory` as a
classification-only label. The 3-digit number is allocated at that task's first
commit; if `026` is taken when the task runs, take the next free number and note
it in `carryover-02.md`. No other task introduces an ADR; no task may violate an
accepted ADR.

**README.md + CLAUDE.md** receive their full pass in task-08 (the final
finalization), except the one CLAUDE.md publish-line edit that task-01 and
task-05 make in lock-step with the publish-precondition change they own. The
`spec/architecture-lint.spec.ts` regression fixtures for the new `pricing` module
are added in task-01 (when the module is born) and re-verified in task-08.

## Cleanup-first task

**task-01 is the cleanup-first task.** The pricing schema is purely additive
(the epic's Persistence Changes record "Removed: none"), so the single obsolete
artifact is the *warn-and-proceed* publish-price placeholder in
`publish-product.use-case.ts` (its inline comment, its `logger.warn(...)` call,
and the `'warns that the active-price precondition is deferred'` spec test).
task-01 **deletes** that placeholder (it does not rename it) and fixes the
references the removal leaves dangling (the `CLAUDE.md` publish line and the
epic-02 implementation-doc passages that describe a "warn-not-block seam"). The
real hard-fail enforcement is added later, in task-05, once Select Applicable
Price exists to back it.

## Self-containment rule

No file under `docs/`, `apps/`, `libs/`, `http/`, `scripts/`, `spec/`,
`migrations/`, `README.md`, or `CLAUDE.md` may reference any path under `tmp/`,
or use the words "epic"/"task" as names for this planning process. Forward and
backward work is described by capability (e.g. "the pricing capability", "a
later cart/order capability"), never by an epic/task number.

## Cumulative exit criteria (gate for "all tasks complete")

- [ ] `yarn lint` passes (`--max-warnings 0`); the `pricing` module's boundaries
      match the existing `catalog`/`stock`/`orders` module shapes.
- [ ] `yarn test:unit` passes; ≥5 new pricing spec files green
      (`price.model`, `tax-category.model`, `set-price.use-case`,
      `schedule-price.use-case`, `select-applicable-price.use-case`) plus the
      updated `publish-product.use-case.spec.ts` asserting the new hard-fail.
- [ ] `yarn test:e2e` passes; `test/pricing.e2e-spec.ts` green; the
      publish-no-price hard-fail is covered.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev && yarn test:seed`
      boots clean and seeds USD prices for every seeded variant.
- [ ] Every request in `http/pricing.http` executes end-to-end.
- [ ] `GET /api/catalog/variants/:variantId/price?currency=USD` returns the
      seeded Price.
- [ ] The at-most-one `valid_to IS NULL` per `(variantId, currency)` invariant is
      verified by the concurrency test.
- [ ] Per-topic docs present under
      `docs/implementation/03-pricing-price-and-tax-category/`.
- [ ] `README.md` API / Caching / Environment sections updated; `CLAUDE.md`
      catalog section, message-pattern list, and forbidden-import note updated.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `scripts/`, `spec/`,
      `migrations/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`
      or uses the words "epic"/"task".
