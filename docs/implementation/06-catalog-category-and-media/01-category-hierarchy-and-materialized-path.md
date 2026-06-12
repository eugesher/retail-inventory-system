# 01 — Category hierarchy and the materialized path

This document records the **catalog category hierarchy**: a `Category` write
aggregate that models a tree with a *materialized path*, its repository contract
and TypeORM adapter (including the one-transaction subtree rebase), the
`category` + `product_categories` schema, and the two write operations that drive
it over RabbitMQ — **create a category** and **reparent a subtree**. The domain
model, persistence, and migration are the foundation; the create/reparent use
cases, their wire contracts, and the `catalog.category.create` /
`catalog.category.reparent` RPC keys build directly on that contract and are
covered in §8–§9. Two category capabilities are still ahead — **reclassifying a
product** into categories and **browsing** a category's products — along with the
gateway HTTP surface that fronts these RPCs; they reuse this same repository port.

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
[`migrations/1781189000000-CreateCategoryTables.ts`](../../../migrations/1781189000000-CreateCategoryTables.ts).

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

Reparenting a category is the one structurally interesting category write: moving
a node moves its **whole subtree**, because every descendant's materialized `path`
embeds the moved node's path as a prefix. The work is split deliberately across
the domain and the repository.

### Who recomputes what

`Category.reparentUnder(newParent | null)` recomputes **only the moved node's own**
`parentId` + `path` — a `null` parent demotes it to a root (`path = '/<slug>'`),
otherwise it hangs off the new parent (`path = newParent.path + '/<slug>'`). It
does **not** touch its descendants: each `category` row is its own aggregate, so
rebasing the rest of the subtree is a persistence concern, not a model one. Before
mutating, it runs the **cycle guard** — `isAncestorOfOrSelf(newParent)` from §3 —
and throws `CATEGORY_CYCLE` when the target is the node itself or one of its own
descendants. You cannot move a branch under a leaf of that same branch; the
path-prefix test catches it with no recursion. The `/`-boundary edge matters here
too: with paths `/a` and `/ab`, moving `/a` under `/ab` is **allowed** (`/ab` is a
different category that merely shares a slug prefix — it is not a descendant of
`/a`), whereas moving `/a` under `/a/b` is rejected.

`ReparentCategoryUseCase` is the orchestrator that sequences this with the
repository:

1. `findBySlug(slug)` the category to move → `CATEGORY_NOT_FOUND` (404) on a miss.
2. Resolve the destination parent: a non-null `newParentSlug` → `findBySlug` →
   `CATEGORY_PARENT_NOT_FOUND` (404) on a miss, `CATEGORY_ARCHIVED` (409) on an
   archived parent (a live subtree must not be moved under a hidden one);
   `null`/omitted → root demotion.
3. **Snapshot `oldPath = category.path` BEFORE** calling `reparentUnder`. This is
   load-bearing: the repository rebases descendants by matching the *old* path
   prefix, so it must be captured while the aggregate still carries the pre-move
   path. Recomputing first would lose it.
4. `category.reparentUnder(newParent)` — recompute own position + the cycle guard.
5. `repository.reparentSubtree(category, oldPath)` — persist both halves in one
   transaction (below) and return the descendant-rewrite count.
6. Map the moved aggregate (already carrying its recomputed position) into the
   response and surface the count.

### The one-transaction subtree rebase

`CategoryTypeormRepository.reparentSubtree(category, oldPath)` writes both the
moved row and every descendant inside a **single** `manager.transaction` — the
`PricingTypeormRepository.appendPrice` precedent, where the transaction lives
inside the repository method (no `ITransactionPort` needed). A window in which the
parent had moved but its descendants still carried the old prefix would leave the
tree internally inconsistent, so the two statements commit together:

```sql
-- 1. the moved row: write its already-recomputed parent_id + path
UPDATE category SET parent_id = ?, path = ? WHERE id = ?;

-- 2. every strict descendant: swap the old path prefix for the new one in bulk
UPDATE category
   SET path = CONCAT(?, SUBSTRING(path, ? + 1))
 WHERE path LIKE ?;
```

The bulk statement is the heart of the rebase. `SUBSTRING(path, LENGTH(oldPath) + 1)`
is the **tail** of each descendant path after the old prefix (for a descendant
`/electronics/phones/audio` moved out of `/electronics/phones`, the tail is
`/audio`), and `CONCAT(newPath, …)` re-prefixes it with the moved node's new path
— so `/gadgets/phones/audio` falls out. The `LIKE` bind is `oldPath + '/%'`, which
matches **strict descendants only** and excludes the moved row itself (its path no
longer starts with `oldPath/` after step 1). Both statements are **parameterized**
— `?` placeholders bound by the driver, never string-interpolated; a materialized
path contains only kebab-case slugs and `/`, so it can never carry a `LIKE`
wildcard, but the bind keeps the query injection-safe regardless. The statement
returns mysql2's `affectedRows` — the descendant-rewrite count the response
surfaces (`CategoryReparentView.rewrittenDescendantCount`; `0` for a leaf move).

### Root demotion and the idempotent same-parent reparent

Two edges fall out of the same mechanism for free, neither special-cased:

- **Root demotion** — omitting `newParentSlug` (or sending `null`) reparents under
  `null`: `reparentUnder(null)` recomputes the path to `/<slug>` and nulls
  `parentId`. A category dragged out of `/electronics/phones` to the top becomes
  `/phones`, and its descendants rebase onto the new short prefix exactly as a
  normal move.
- **Same-parent reparent is an idempotent success** — moving a category under the
  parent it already has recomputes its path to the identical value, and the cycle
  guard does **not** fire (a node is not its own descendant). The rebase rewrites
  the descendants to the same paths they already held. This is deliberately **not**
  rejected: a no-op move returning the unchanged tree is the least surprising
  behaviour for a caller that re-issues a move.

## 9. The write operations over RabbitMQ

Both category writes are RPC commands (Gateway → Catalog on `catalog_queue`),
served by `CategoryController` — a controller **separate** from the product
`CatalogController` so each file stays one-aggregate-shaped. The handlers are thin
(`@MessagePattern` → use case); `correlationId` is logged inline inside each use
case, never in the handler, because `PinoLogger.assign()` throws outside an HTTP
request scope (ADR-001 / ADR-011). The `APP_FILTER`-registered
`CatalogRpcExceptionFilter` already covers every controller in the module, so the
`CATEGORY_*` codes map to HTTP with no extra wiring. **The category capability
emits no events** (§6), so there are no past-tense `catalog.category.*` surfaces to
pair with these commands.

| RPC key | Use case | Payload | Response |
| --- | --- | --- | --- |
| `catalog.category.create` | `CreateCategoryUseCase` | `ICreateCategoryPayload` (`name`, `slug`, `parentSlug?`, `sortOrder?`) | `CategoryView` |
| `catalog.category.reparent` | `ReparentCategoryUseCase` | `IReparentCategoryPayload` (`slug`, `newParentSlug?`) | `CategoryReparentView` |

**Create** inserts an `active` category: it pre-checks slug uniqueness through the
repository (`existsBySlug` → `CATEGORY_SLUG_TAKEN`, the UNIQUE constraint staying
the hard guard), resolves the parent by slug when `parentSlug` is present (a miss
is `CATEGORY_PARENT_NOT_FOUND`, an archived parent `CATEGORY_ARCHIVED` — a new
child must not extend a hidden subtree), then `Category.create(...)` derives the
`path` from the loaded parent (root when absent) and enforces the field invariants.
The parent is addressed by **slug**, not id — the stable handle the gateway holds.

The contracts (`CategoryView` / `CategoryReparentView` / `ICreateCategoryPayload` /
`IReparentCategoryPayload`) live in `@retail-inventory-system/contracts`, imported
by both the gateway and the catalog microservice, so a drift fails TypeScript on
both ends (ADR-005). The dotted RPC keys are mirrored value-for-value into
`MicroserviceMessagePatternEnum`, locked by `routing-keys.constants.spec.ts`
(ADR-008). The shared `toCategoryView` factory is the single projection from the
`Category` aggregate to the wire view (the `catalog-view.factory.ts` pattern).

### The use-case rejection matrix

Every category rejection is a typed `CatalogErrorCodeEnum` code the filter maps to
an HTTP status:

| Code | HTTP | Raised when |
| --- | --- | --- |
| `CATEGORY_NAME_REQUIRED` / `CATEGORY_SLUG_INVALID` / `CATEGORY_SORT_ORDER_INVALID` | 400 | `Category.create` invariant violation (malformed input). |
| `CATEGORY_NOT_FOUND` | 404 | Reparent target slug resolves to nothing. |
| `CATEGORY_PARENT_NOT_FOUND` | 404 | Create/reparent parent slug resolves to nothing. |
| `CATEGORY_SLUG_TAKEN` | 409 | Create slug already exists. |
| `CATEGORY_ARCHIVED` | 409 | Create/reparent under an archived parent. |
| `CATEGORY_CYCLE` | 409 | Reparent under self or a descendant. |

**No gateway HTTP route ships yet** — the RPCs are reachable through an RMQ client
and exercised by the use-case unit specs; the gateway `modules/catalog/` route
that fronts them lands with the gateway category work.

## See also

- [ADR-029](../../adr/029-category-materialized-path-and-polymorphic-media.md) —
  the decision of record: the materialized path, the reparent split, cycle
  detection in the domain, no events, and the per-aggregate repository port.
- [ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md) — the catalog
  `Product` aggregate whose template (`AggregateRoot` + status soft-delete,
  repository-level slug uniqueness, the typed `CatalogDomainException`) `Category`
  follows.
- [ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md) — the dotted routing-key
  convention and the `ROUTING_KEYS` ⇆ `MicroserviceMessagePatternEnum` lock-step.
