---
epic: epic-02
task_number: 3
title: Product and ProductVariant domain
depends_on: [task-01, task-02]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/03-product-and-variant-domain.md
adr_deliverable: docs/adr/025-catalog-product-and-variant-aggregate.md
---

# Task 03 — Product and ProductVariant domain

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the `docs/adr/` documents related to this task.

Most relevant ADRs: **ADR-004** (per-module hexagonal; `domain/` imports nothing
but `libs/{ddd,common,contracts}` — no `@nestjs/*`, no TypeORM, no
`class-validator`), **ADR-013** (the Order aggregate is the closest precedent:
`AggregateRoot` + `pullDomainEvents()`), **ADR-003** (ADR cadence — this task
records ADR-025).

## Goal

Model the catalog write-side domain: a `Product` aggregate root that owns its
`ProductVariant` children, the lifecycle state machine, the cross-aggregate
invariants, and the three state-transition domain events. Pure framework-free
domain code with spec siblings. No persistence, no Nest wiring (later tasks).

## Entry state assumed

- task-01–02 carryover present. The catalog app boots empty; `modules/catalog/`
  exists with an empty `catalog.module.ts`. No `domain/` folder yet.
- The `retail_db` schema has no `product` table; the catalog tables do not exist
  yet (task-04 creates them). This task writes **no** SQL.
- `@retail-inventory-system/ddd` exports `Entity<TId>`, `AggregateRoot<TId>`
  (with `pullDomainEvents()`), `ValueObject<TProps>`, `DomainEvent<TAggregateId>`.
- `@retail-inventory-system/common` exports `Result`, `DomainException`.

## Scope

**In**

- `Product` aggregate root, `ProductVariant` child entity, value objects,
  lifecycle enums, and the three domain events — under `modules/catalog/domain/`.
- Domain spec files for the two models.
- ADR-025 and the domain doc.

**Out**

- Entities/mappers/repository/migration (task-04).
- Use cases, ports, controllers, wire events (task-05+).
- Reading the active-Price precondition from a real Price (deferred — see
  task-06); the publish rule here is "≥1 variant" plus a documented placeholder
  for the future Price check.

## Aggregate boundaries (record in ADR-025)

- **Product is the aggregate root.** A `ProductVariant` is a child entity inside
  `Product` on the write path (variants are added/validated through the root).
  On the read path a variant is addressable top-level (task-07) — that's a read
  model, not a second write aggregate.
- No `version` column / optimistic lock at this stage — catalog is last-writer-wins
  (not in the no-oversell critical path).
- **Soft-delete is via `status`, never a `deletedAt` timestamp.** Archived rows
  stay resolvable forever (historical orders/stock reference variants by id).

## Field shapes (copy verbatim — the executor needs only this file)

**Product**

| Field | Type | Notes |
|---|---|---|
| `id` | `number \| null` | null before persistence assigns it (mirror `Order`) |
| `name` | `string` | required, non-empty |
| `slug` | `string` | unique (uniqueness enforced at the repository — see invariants) |
| `description` | `string` | may be empty |
| `status` | `ProductStatusEnum` | `draft \| active \| archived` |
| `variants` | `ProductVariant[]` | the owned children |
| `createdAt` / `updatedAt` | `Date` | set by persistence |

**ProductVariant**

| Field | Type | Notes |
|---|---|---|
| `id` | `number \| null` | |
| `productId` | `number \| null` | parent id |
| `sku` | `string` | globally unique (repository-enforced) |
| `gtin` | `string \| null` | optional |
| `optionValues` | `Record<string, string>` | e.g. `{ color: 'red', size: 'M' }`; **non-empty map** invariant |
| `weightG` | `number \| null` | grams, integer, **non-negative** when present |
| `dimensionsMm` | `{ l: number; w: number; h: number } \| null` | mm, optional |
| `status` | `ProductVariantStatusEnum` | `active \| archived` |
| `createdAt` / `updatedAt` | `Date` | |

## Lifecycle state machines

**Product status** (`ProductStatusEnum`: `DRAFT='draft'`, `ACTIVE='active'`,
`ARCHIVED='archived'`):

- `draft → active` via `publish()` — precondition: **≥1 variant**. (A second
  precondition, "≥1 active Price", belongs to a future pricing capability; model
  it as a clearly-named placeholder/seam here and document that until pricing
  lands the publish path will warn rather than block — the warn lives in the use
  case, task-06, not the domain.)
- `active → archived` via `archive()`.
- **No** `archived → draft` and **no** `archived → active` (archival is terminal
  for this work). `publish()` on a non-draft and `archive()` on a non-active
  raise a `DomainException`.

**ProductVariant status** (`ProductVariantStatusEnum`: `ACTIVE='active'`,
`ARCHIVED='archived'`): variants are created `active`; archival of a variant is
not a Stage-1 operation — model the enum but you need no transition method beyond
construction in this task.

## Invariants to enforce in the domain

- `Product.name` non-empty; `Product.slug` non-empty. **slug global uniqueness**
  is a repository-level guarantee (the domain cannot see other aggregates) —
  assert it in the use-case/repository spec via a test double, and document that
  the domain trusts the repository to reject a duplicate slug.
- `ProductVariant.sku` non-empty; **sku global uniqueness** is likewise
  repository-level.
- `ProductVariant.optionValues` is a **non-empty** map.
- `ProductVariant.weightG`, when present, is a non-negative integer.
- `publish()` requires `variants.length >= 1`.

## Domain events (model on `apps/retail-microservice/.../domain/.../events/`)

Three `DomainEvent` subclasses, recorded on the aggregate and drained by the use
case via `pullDomainEvents()` (the use case maps them to wire events in
task-05/06 — the domain event is **not** serialized across services):

- `VariantCreatedEvent` — carries `productId`, `variantId`, `sku`.
- `ProductPublishedEvent` — carries `productId`, `slug`, `variantIds: number[]`.
- `ProductArchivedEvent` — carries `productId`.

`Product.addVariant(...)` records `VariantCreatedEvent`; `Product.publish()`
records `ProductPublishedEvent`; `Product.archive()` records
`ProductArchivedEvent`.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/domain/product.model.ts`
- `apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts`
- `apps/catalog-microservice/src/modules/catalog/domain/product-status.enum.ts`
- `apps/catalog-microservice/src/modules/catalog/domain/product-variant-status.enum.ts`
- Value objects as needed (e.g. `option-values.vo.ts`, `dimensions.vo.ts`) under
  `domain/` — only if they earn their place; primitive-plus-invariant in the
  model is acceptable for `sku`/`slug`.
- `apps/catalog-microservice/src/modules/catalog/domain/events/variant-created.event.ts`
- `apps/catalog-microservice/src/modules/catalog/domain/events/product-published.event.ts`
- `apps/catalog-microservice/src/modules/catalog/domain/events/product-archived.event.ts`
- `apps/catalog-microservice/src/modules/catalog/domain/events/index.ts`
- `apps/catalog-microservice/src/modules/catalog/domain/index.ts`
- Specs (see Tests).

## Files to modify

- `apps/catalog-microservice/src/modules/catalog/index.ts` — re-export the domain
  barrel if that matches the inventory/notification convention.

## Files to delete

- None.

## Tests

- `apps/catalog-microservice/src/modules/catalog/domain/spec/product.model.spec.ts`
  — status transitions (`draft→active→archived`; reject `publish()` on a
  non-draft and on a product with zero variants; reject `archive()` on a
  non-active); `publish()` records `ProductPublishedEvent` with the right
  `variantIds`; `archive()` records `ProductArchivedEvent`. Note the slug
  uniqueness invariant is repository-level (assert that in task-05's use-case
  spec, not here) — leave a comment pointing to that.
- `apps/catalog-microservice/src/modules/catalog/domain/spec/product-variant.model.spec.ts`
  — non-empty `optionValues`; non-negative `weightG`; `addVariant` records
  `VariantCreatedEvent`.
- No e2e in this task; `yarn test:e2e` must stay green (regression).

## Doc deliverable

`docs/implementation/02-catalog-product-and-variant/03-product-and-variant-domain.md`.
Outline: aggregate boundaries (root vs child; write vs read addressing),
invariants and where each is enforced (domain vs repository), the two status
state machines (with the rejected transitions), the three domain events and the
`pullDomainEvents()` drain model, and the soft-delete-via-`status` decision.
Cross-link ADR-025 and ADR-013 by relative path.

## ADR deliverable

`docs/adr/025-catalog-product-and-variant-aggregate.md` — **Date** 2026-06-02,
**Status** Accepted. Allocate the number `025` (confirmed next-free). Nygard
hybrid (Status, Context, Decision, Alternatives Considered, Consequences):

- **Context** — the merchandisable graph needs a single owner; the inventory
  `product` stub was removed (see `02-inventory-product-stub-removed.md`) to free
  the shared-schema table name.
- **Decision** — a new `catalog` bounded context owns `Product` (aggregate root;
  `draft/active/archived`; soft-delete via `status`) 1→N `ProductVariant`
  (sellable, stocked, priced unit; `sku` globally unique). The downstream
  backbone key is **`variantId`** (inventory stock, pricing, order lines key on
  the variant, not the product). State transitions emit versioned (`v1`) events.
- **Alternatives** — keep product inside inventory (rejected: inventory should
  not own merchandising); key downstream on `productId` (rejected: the variant
  is the sellable unit); add an optimistic-lock `version` column now (rejected:
  catalog is last-writer-wins, not in the no-oversell path).
- **Consequences** — later inventory work reshapes `product_stock.product_id`
  onto `variantId`; the `BaseEntity` `deletedAt` column is inherited but left
  inert (lifecycle is `status`-driven). Describe forward work by capability, not
  by an epic/task id.

## Carryover to read

`carryover-01.md`, `carryover-02.md`.

## Carryover to produce

Write `carryover-03.md` capturing: the domain files + enums + events now on
disk; the exact event class names and their payload fields (task-05/06 map these
to wire events); the ADR-025 number is **allocated and committed**; the
repository-level uniqueness decision (so task-04/05 enforce slug/sku there);
verification commands (`yarn test:unit`, `yarn lint`).

## Exit criteria

- [ ] `Product` (aggregate root) + `ProductVariant` + the two status enums + the
      three domain events exist under `modules/catalog/domain/`, framework-free.
- [ ] The two domain spec files cover the transitions, rejections, invariants,
      and recorded events listed under Tests.
- [ ] ADR-025 is written and accepted; CLAUDE.md's "next free number is 025" is
      now consumed (CLAUDE.md itself is updated in task-10).
- [ ] `yarn lint` passes (`--max-warnings 0`); the domain layer imports only
      `libs/{ddd,common,contracts}` (boundaries green).
- [ ] `yarn test:unit` passes (new domain specs green); `yarn test:e2e` passes.
- [ ] `docs/implementation/02-catalog-product-and-variant/03-product-and-variant-domain.md` is written.
- [ ] The self-containment grep is clean:
      `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- [ ] `carryover-03.md` is written.
