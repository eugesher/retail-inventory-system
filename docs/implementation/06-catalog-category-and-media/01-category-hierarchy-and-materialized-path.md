# 01 — Category hierarchy and the materialized path

This document records the **foundation of the catalog category hierarchy**: a
`Category` write aggregate that models a tree with a *materialized path*, its
repository contract and TypeORM adapter (including the one-transaction subtree
rebase), and the `category` + `product_categories` schema. It is the first half
of the category capability — the domain model, the persistence, and the
migration. The use cases that *drive* it (create a category, reparent a subtree,
reclassify a product, browse by category) build on this contract in later
catalog work; the "Reparenting and cycle detection in practice" section below is
the seam they fill in.

The code lives under `apps/catalog-microservice/src/modules/catalog/` — `Category`
is a **sibling write aggregate inside the existing catalog module**, next to
`Product`/`ProductVariant`, not a new bounded context. The decision and its
rationale (including the polymorphic `MediaAsset` design a later session builds)
are in
[ADR-029](../../adr/029-category-materialized-path-and-polymorphic-media.md); the
catalog `Product` aggregate it mirrors is
[ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md).

## 1. Why a materialized path

A category tree answers read-shallow questions ("list everything under
Electronics", "is A an ancestor of B?") and mutates rarely (a merchandiser
occasionally moves a branch). The representation is chosen for that shape: each
`category` row stores its **full root-to-self slug path** in a single indexed
column.

```
electronics            → path = '/electronics'
electronics / phones   → path = '/electronics/phones'
electronics / phones / smartphones → path = '/electronics/phones/smartphones'
```

With the path materialized:

- A **subtree read** is one indexed predicate —
  `path = '/electronics' OR path LIKE '/electronics/%'` — no recursion, no
  join fan-out.
- An **ancestry test** is a pure string-prefix check (see §3).

The alternatives were weighed in
[ADR-029 §2](../../adr/029-category-materialized-path-and-polymorphic-media.md)
and rejected:

| Approach | Why not |
| --- | --- |
| **Closure table** (`ancestor, descendant, depth` rows) | A second table plus a write fan-out — one row per ancestor×descendant — on every insert/move, for a tree that is read-shallow and write-rare. |
| **Nested sets** (left/right boundary numbers) | Every insert rebalances a large span of boundary numbers; the write cost is wrong for a hand-edited tree. |
| **Per-query recursive CTE** (no stored hierarchy) | Pushes the tree walk into every read and stores nothing to index or inspect. |

The materialized path gets the O(1)-ish subtree read of a closure table from one
column, with no fan-out write and a hierarchy you can read straight off the row.

## 2. The path semantics and the kebab-case slug invariant

A path is `/` followed by the slugs from the root to the node, joined by `/`. The
factory derives it:

- `Category.create({ name, slug })` — a **root**: `path = '/' + slug`,
  `parentId = null`.
- `Category.create({ name, slug, parent })` — a **child**:
  `path = parent.path + '/' + slug`, `parentId = parent.id`.

Because the slug is a **path segment**, the `Category` slug invariant is
**stricter than `Product`'s**. `Product.slug` need only be non-empty;
`Category.slug` must be **kebab-case** — `^[a-z0-9]+(?:-[a-z0-9]+)*$` (lowercase
alphanumerics in `-`-separated groups, no leading/trailing/doubled `-`). A slug
containing a space, a slash, or an uppercase letter would corrupt every
descendant's `path`, so the model rejects it at construction with
`CATEGORY_SLUG_INVALID`. The pattern is the same literal the gateway validates for
product slugs, **re-declared** in the catalog `domain/` because the domain imports
nothing from the gateway (ADR-004 / ADR-017).

The other construction invariants: `name` non-empty (`CATEGORY_NAME_REQUIRED`) and
`sortOrder` a non-negative integer (`CATEGORY_SORT_ORDER_INVALID`).
`Category.reconstitute(...)` is the load path — it takes the stored `path` as-is
and applies the field invariants but no status guard (any status reconstitutes,
including `archived`).

## 3. Ancestry as a pure prefix test

`isAncestorOfOrSelf(other)` is the whole hierarchy predicate:

```ts
other.path === this.path || other.path.startsWith(this.path + '/')
```

The trailing `/` is load-bearing. Without it, `/a` would falsely register as an
ancestor of `/ab` — a different category that merely shares a slug prefix. With
the `/` boundary, `/a` is an ancestor of `/a/b` but **not** of `/ab`. This pure,
schema-free test is also the cycle guard the reparent path calls (§6).

## 4. The schema

Two tables ship in
[`migrations/1781260000000-CreateCategoryTables.ts`](../../../migrations/1781260000000-CreateCategoryTables.ts).

`category`:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `BIGINT UNSIGNED AUTO_INCREMENT` | The catalog-table convention (`product` is the same); a narrower `INT` would also mismatch `product_categories.category_id`. |
| `name` | `VARCHAR(255)` | |
| `slug` | `VARCHAR(255)` | `UNIQUE` (`UC_CATEGORY_SLUG`) — global uniqueness is repository-level (§5). |
| `parent_id` | `BIGINT UNSIGNED NULL` | Self-FK; `NULL` = a root. |
| `path` | `VARCHAR(512)` | The materialized path; indexed (`IDX_CATEGORY_PATH`). |
| `sort_order` | `INT NOT NULL DEFAULT 0` | Sibling display order. |
| `status` | `ENUM('active','archived')` | Lifecycle (§7). |
| `created_at` / `updated_at` / `deleted_at` | `TIMESTAMP` | `deleted_at` inherited from `BaseEntity`, left **inert**. |

The self-FK `FK_CATEGORY_PARENT` is `ON DELETE SET NULL` — a **schema-level safety
net only.** No hard-delete operation exists (archival is the path), but if a row
were ever deleted by hand its children demote to roots (their `parent_id` nulled)
rather than blocking the delete or cascading it away. `IDX_CATEGORY_PARENT` indexes
the self-FK column.

`product_categories` is a **bare N↔M join** — composite PK `(product_id,
category_id)`, no surrogate id, no timestamps — with both FKs `ON DELETE CASCADE`
(a membership row is meaningless once either side is gone) and `category_id`
indexed for the reverse lookup. It deliberately gets **no TypeORM entity**: the
repository will maintain it with parameterized SQL through the injected manager
(the `product_variant.tax_category_id` precedent from pricing). The table ships now;
the membership read/write methods land with the reclassify capability.

## 5. The repository port (one seam per aggregate)

`Category` gets its **own** repository port, `ICategoryRepositoryPort`
(`CATEGORY_REPOSITORY`), separate from `CATALOG_REPOSITORY` (Product). A port per
aggregate seam — the `ACTIVE_PRICE_PROBE` precedent — keeps
`ICatalogRepositoryPort` from swelling into a module-wide grab-bag
([ADR-029 §8](../../adr/029-category-materialized-path-and-polymorphic-media.md)).
The port returns **domain types only**; no `typeorm` type leaks across it
(ADR-017). Its surface:

```ts
save(category: Category): Promise<Category>;        // insert/update one row; re-reads for the concrete id
findById(id: number): Promise<Category | null>;
findBySlug(slug: string): Promise<Category | null>;
existsBySlug(slug: string): Promise<boolean>;       // the create-use-case duplicate pre-check
listAll(opts: { rootOnly?: boolean; activeOnly?: boolean }): Promise<Category[]>;
listSubtree(pathPrefix: string, opts?: { activeOnly?: boolean }): Promise<Category[]>;
reparentSubtree(category: Category, oldPath: string): Promise<number>;
```

Global `slug` uniqueness is **repository-level** (the `UNIQUE` constraint is the
hard guard; `existsBySlug` gives the later create use case a clean pre-check), the
same convention as `Product.slug`/`ProductVariant.sku` — the domain cannot see
other aggregates, so it trusts the repository to reject a clash.

`CategoryTypeormRepository` is the single `@InjectRepository(CategoryEntity)` site.
The `CategoryMapper` coerces the `parent_id` column back to a `number` while
preserving `null` (mysql2 surfaces a non-PK `BIGINT` as a string; `Number(null)`
would be `0`, forging a child of a non-existent category 0).

## 6. No domain events

Unlike `Product` — which records `VariantCreatedEvent` / `ProductPublishedEvent` /
`ProductArchivedEvent` — `Category` records **nothing**. It extends
`AggregateRoot`, but it never calls `addDomainEvent`, and `pullDomainEvents()`
always drains empty. Category edits are not in the system's must-emit set; no
cross-service consumer reacts to a category create or move today. A future
cache-invalidation event (e.g. "a subtree moved, re-warm the browse cache") would
be additive and gets its own decision when a consumer exists
([ADR-029 §6](../../adr/029-category-materialized-path-and-polymorphic-media.md)).

## 7. Soft-delete via `status`

Lifecycle is `status`-driven (`active` / `archived`), the ADR-025 convention; the
inherited `deletedAt` column stays inert. `Category.archive()` flips
`active → archived` and rejects a second call (`CATEGORY_INVALID_STATE_TRANSITION`)
— archival is terminal. No archive *endpoint* ships in this capability; the mutator
exists because the soft-delete lifecycle is status-driven and the seed/tests may
exercise it. An archived category stays resolvable forever, so any historical
membership or reference to its id never dangles.

The nine `CATEGORY_*` codes added to `CatalogErrorCodeEnum` map to HTTP through the
existing `CatalogRpcExceptionFilter`: the input invariants
(`CATEGORY_NAME_REQUIRED` / `CATEGORY_SLUG_INVALID` / `CATEGORY_SORT_ORDER_INVALID`)
→ 400; the lookups (`CATEGORY_NOT_FOUND` / `CATEGORY_PARENT_NOT_FOUND`) → 404; the
conflicts (`CATEGORY_SLUG_TAKEN` / `CATEGORY_CYCLE` /
`CATEGORY_INVALID_STATE_TRANSITION` / `CATEGORY_ARCHIVED`) → 409. The
repository-level codes have no thrower yet — the use cases arrive next — but
landing the codes and mappings here keeps the filter's status map total.

## 8. Reparenting and cycle detection in practice

> **Placeholder — completed by the reparent use-case work.**
>
> The mechanism is in place at the model and repository layers and is described
> above:
>
> - `Category.reparentUnder(newParent | null)` recomputes the moved category's
>   **own** `parentId` + `path` (a `null` parent demotes it to a root) and rejects
>   a cycle with `CATEGORY_CYCLE` when `this.isAncestorOfOrSelf(newParent)` (you
>   cannot move a category under itself or one of its own descendants).
> - `CategoryTypeormRepository.reparentSubtree(category, oldPath)` rebases the
>   subtree in **one** transaction: the moved-row `UPDATE`, then a single bulk
>   `UPDATE category SET path = CONCAT(?, SUBSTRING(path, LENGTH(oldPath)+1))
>   WHERE path LIKE ?` over the old subtree (all parameterized), returning the
>   descendant-rewrite count.
>
> The end-to-end reparent flow — the use case that loads the category and the new
> parent, snapshots the old path, calls `reparentUnder`, persists via
> `reparentSubtree`, and surfaces the rewrite count in the response, plus the RPC
> key, the gateway route, and the worked example of a multi-level move — is
> documented here when that work lands.
