# 02 — Product↔category membership, reclassify, and the category read paths

This document records how a product becomes **classifiable** into categories and
how the category hierarchy becomes **readable**: the bare `product_categories`
N↔M join and the repository methods that maintain it, the **reclassify** write
that attaches and detaches a product's memberships in one command, and the three
read paths a store-front navigates with — **list** (flat), **tree** (nested
subtree), and **browse-by-category** (the products under a category). It builds
directly on the `Category` aggregate, its repository port, and the `category` +
`product_categories` schema laid down in
[01 — Category hierarchy and the materialized path](01-category-hierarchy-and-materialized-path.md);
the design decisions are fixed in
[ADR-029](../../adr/029-category-materialized-path-and-polymorphic-media.md).

All four operations are RPCs on `catalog_queue`, served by the catalog
`category.controller.ts` alongside the create/reparent handlers from doc 01.
There is **no gateway HTTP surface yet** — these RPCs are reachable from an RMQ
client and the unit suite; the HTTP edge is a later catalog capability.

| RPC key | Use case | Response |
| --- | --- | --- |
| `catalog.category.list` | `ListCategoriesUseCase` | `CategoryView[]` |
| `catalog.category.get-tree` | `GetCategoryTreeUseCase` | `CategoryTreeNodeView` |
| `catalog.category.list-products` | `ListCategoryProductsUseCase` | `IPage<ProductWithVariantsView>` |
| `catalog.product.reclassify` | `ReclassifyProductUseCase` | `ProductCategoriesView` |

`catalog.product.reclassify` is a `product.*` key but is served by the **category**
controller — the operation's subject is the product's category membership, not the
product header (the same shape as `retail.cart.place` being served by the orders
controller because it produces an `Order`).

## 1. Why `product_categories` is a bare join, owned by neither aggregate

A product belongs to many categories; a category lists many products. The
membership is a classic N↔M relationship, and it is stored as a **bare join
table**:

```sql
CREATE TABLE product_categories (
  product_id  BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (product_id, category_id),
  FOREIGN KEY (product_id)  REFERENCES product(id)  ON DELETE CASCADE,
  FOREIGN KEY (category_id) REFERENCES category(id) ON DELETE CASCADE
);
```

The composite `(product_id, category_id)` **is** the primary key — there is no
surrogate `id`, no `created_at`/`updated_at`, and **no TypeORM entity**. Three
deliberate choices flow from one observation: *a membership row carries no state
of its own*. It is a pure link, so:

- **A composite PK, not a surrogate id.** The pair already uniquely identifies the
  link; a surrogate `id` would add a column to index and reconcile for no gain. The
  composite PK doubles as the de-duplication guard — re-inserting an existing pair
  collides with the primary key, which is exactly the idempotency hook §2 relies
  on.
- **No timestamps.** Nothing reads "when was this product filed under
  Electronics"; the merchandising history that would justify an audit trail does
  not exist for category membership.
- **No entity, no in-memory ownership.** Neither `Product` nor `Category` loads the
  membership collection into the aggregate. Folding either side's list into the
  write model would bloat it with a relationship that **browse reads care about,
  the write path does not** — placing an order, publishing a product, or reparenting
  a category never needs to know the membership. So the join is maintained
  **directly at the repository** with parameterized SQL through the injected
  `EntityManager`, the same opaque-id, no-entity technique pricing uses for
  `product_variant.tax_category_id`
  ([ADR-026 §5](../../adr/026-price-append-only-ledger-and-tax-category.md)).

The membership methods live on `ICategoryRepositoryPort` (the category seam), and
the category-scoped product **browse** lives on `ICatalogRepositoryPort` (the
product seam) — a port per aggregate
([ADR-029 §8](../../adr/029-category-materialized-path-and-polymorphic-media.md)).
The split is "where does the returned thing belong": membership writes and the
"what categories is this product in" read return categories, so they sit on the
category port; the browse returns **products**, so it sits with the product
repository.

## 2. Idempotent attach (`INSERT IGNORE`) and detach (`DELETE`)

The reclassify RPC may be **retried** — a network hiccup between the gateway and
the broker, an at-least-once redelivery — so applying the same attach/detach twice
must converge to the same state, not error or double-count. Both join writes are
therefore idempotent by construction:

```sql
-- attachProductCategories(productId, [3, 5])
INSERT IGNORE INTO product_categories (product_id, category_id) VALUES (?, ?), (?, ?);
--   params: [productId, 3, productId, 5]

-- detachProductCategories(productId, [3, 5])
DELETE FROM product_categories WHERE product_id = ? AND category_id IN (?, ?);
--   params: [productId, 3, 5]
```

- **`INSERT IGNORE`** turns a duplicate-key collision on the composite PK into a
  silent skip, so **re-attaching an existing membership is a no-op success** rather
  than a `409 Duplicate entry`.
- **`DELETE … IN (…)`** matches only rows that exist, so **detaching a membership
  the product never had removes nothing** and still succeeds.

Both statements are **parameterized** — a `(?, ?)` tuple per id for the insert, a
`?` per id in the `IN` list for the delete, bound by the driver. Ids are **never**
string-interpolated into the SQL (the placeholder count is computed from the array
length; the values ride the parameter array). An empty id list short-circuits to a
no-op before any SQL is built — an `INSERT … VALUES` with no tuples or an `IN ()`
with no values is a syntax error.

The idempotency is asserted at the use-case level (re-attach + detach-of-a-
non-membership both succeed and return the unchanged membership) and the SQL shape
is locked at the repository level (the exact parameterized strings).

## 3. Reclassify: the rejection matrix and the archived-category rules

`ReclassifyProductUseCase` takes a `productId`, an `attachCategorySlugs` list, and
a `detachCategorySlugs` list (either may be empty — the gateway's future attach
route sends only the attach list, its detach route only the detach list; one RPC
serves both). It orchestrates two repositories — the catalog repository confirms
the product exists, the category repository resolves slugs and writes the join —
and returns the product header plus its **full current membership** after the
operation (the "updated product header", not a diff).

| Condition | Code | HTTP |
| --- | --- | --- |
| Product id not found | `CATALOG_PRODUCT_NOT_FOUND` | 404 |
| A slug in **either** list resolves to no category | `CATALOG_CATEGORY_NOT_FOUND` | 404 |
| A slug in the **attach** list is an **archived** category | `CATALOG_CATEGORY_ARCHIVED` | 409 |
| A slug in the **detach** list is an **archived** category | *(allowed)* | — |

The asymmetry on archived categories is intentional and mirrors the create/reparent
rules from doc 01:

- **Attach to an archived category is blocked (409).** Newly filing a live product
  under a hidden category would put it in a subtree no browse can reach — almost
  certainly a mistake, so it is rejected.
- **Detach from an archived category is allowed.** A product may carry a *historic*
  membership under a category that was later archived; that membership must stay
  **removable**, or it would be stranded. Cleanup must always be possible.

The codes map to HTTP through the same `CatalogRpcExceptionFilter` (a total
`Record`) that already covers every catalog code; no filter change was needed.

## 4. The read paths: list, tree, and browse-by-category

All three reads are **public browse** reads — they surface only **active**
categories and products. An archived category is hidden, an archived product drops
out of browse (the [ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)
convention), and a draft product is invisible until published.

### `catalog.category.list` — the flat navigation list

`ListCategoriesUseCase` returns every active category as a flat
`CategoryView[]`, ordered `sortOrder ASC, name ASC` (the merchandising order, with
name as a stable tiebreaker — applied in the repository query). An optional
`rootOnly` flag narrows the result to top-level categories (`parent_id IS NULL`)
for a first-level menu. `activeOnly` is hard-wired on — a public browse never
surfaces an archived category.

### `catalog.category.get-tree` — the nested subtree

`GetCategoryTreeUseCase` resolves a category by slug (a missing **or archived**
category is a `404` — the tree is a browse read, and an archived category is hidden
from browse), reads its active subtree with
`listSubtree(path, { activeOnly: true })`, and **assembles the nested
`CategoryTreeNodeView` in the use case**, not in SQL:

1. Index the flat rows by `parentId`.
2. Build the tree top-down from the root, attaching each node's children sorted
   `sortOrder ASC, name ASC`.

`CategoryTreeNodeView` extends the flat `CategoryView` with a self-referential
`children: CategoryTreeNodeView[]`; the Swagger annotation uses the lazy
`type: () => [CategoryTreeNodeView]` thunk so the recursion resolves. A leaf
carries an empty `children` array.

**The archived-intermediate rule.** Because `listSubtree(activeOnly)` excludes
archived rows, a node whose **parent is not in the active set** has no parent to
attach to during assembly and is simply **dropped**. The practical consequence: an
archived intermediate category hides its **whole** subtree from the tree, even the
still-active categories beneath it. This is the pragmatic, documented behaviour —
an archived branch is invisible, top to bottom, with no special-casing in the
assembly code (it falls out of indexing children by `parentId`).

### `catalog.category.list-products` — browse the products under a category

`ListCategoryProductsUseCase` resolves the category (same missing/archived `404`
rule as the tree), then computes the set of category ids to match:

- **`includeDescendants` off** — just the named category's own id.
- **`includeDescendants` on** — the named category **plus every id in its active
  subtree**, gathered with the same `listSubtree(path, { activeOnly: true })`. This
  is the materialized-path expansion: "everything under Electronics" is one indexed
  `path LIKE '/electronics/%'` read, deduped into a flat id set.

That id set is handed to `ICatalogRepositoryPort.listActiveByCategoryIds`, which
returns a page of **active** products attached to **any** of the ids, distinct and
newest-first. Each product is projected through the shared
`catalog-view.factory.ts` (active variants only — identical semantics to the plain
`catalog.product.list` browse), so the response is the familiar
`IPage<ProductWithVariantsView>`. Paging defaults (`page 1`, `size 20`, capped at
`100`) match `ListProductsUseCase`; the gateway will normalize them at the edge in
a later capability, but the RMQ-reachable handler guards them itself.

The membership filter is a **parameterized id-subselect** against the bare join,
never a string-interpolated id list:

```sql
SELECT … FROM product p
LEFT JOIN product_variant pv ON pv.product_id = p.id
WHERE p.status = 'active'
  AND p.id IN (
    SELECT pc.product_id FROM product_categories pc
    WHERE pc.category_id IN (:...categoryIds)   -- ids bound, implicitly DISTINCT
  )
ORDER BY p.id DESC;
```

`IN (subselect)` is implicitly distinct — a product attached to two of the
requested ids appears once — so no explicit `DISTINCT` is needed, and the to-many
`variants` join still paginates correctly because TypeORM resolves the root ids
first when `skip`/`take` meet a to-many join (the same shape the plain browse
relies on).

## 5. No domain events

None of these four operations emits a domain event
([ADR-029 §6](../../adr/029-category-materialized-path-and-polymorphic-media.md)).
The three reads are queries; reclassify is a **read-side navigation reshape** with
no cross-service consumer today. `Category` already records nothing (unlike
`Product`), and `ReclassifyProductUseCase` takes **no events-publisher port at
all** — the cleanest "emits nothing" guarantee is structural rather than a runtime
assertion: there is simply no publisher seam to call. A future cache-invalidation
event ("a category moved, re-warm the browse cache") would be **additive** and gets
its own decision when a consumer exists.

## 6. Where the code lives

| Concern | File |
| --- | --- |
| Reclassify use case | `application/use-cases/reclassify-product.use-case.ts` |
| List / tree / browse use cases | `application/use-cases/list-categories.use-case.ts`, `get-category-tree.use-case.ts`, `list-category-products.use-case.ts` |
| Tree-node + membership-view factory | `application/use-cases/category-view.factory.ts` (`toCategoryTreeNode`), `catalog-view.factory.ts` (`toProductView`) |
| Membership SQL (`INSERT IGNORE` / `DELETE` / id-subselect) | `infrastructure/persistence/category-typeorm.repository.ts` |
| Category-scoped product browse SQL | `infrastructure/persistence/catalog-typeorm.repository.ts` (`listActiveByCategoryIds`) |
| RPC handlers (4) | `presentation/category.controller.ts` |
| Wire contracts | `libs/contracts/catalog/dto/{category-tree,product-categories}.view.ts`, `interfaces/{category-list,category-tree,category-products,product-reclassify}.interface.ts` |
| Routing keys | `libs/messaging/routing-keys.constants.ts` + the mirrored `MicroserviceMessagePatternEnum` |

With these four operations, the category surface is **RPC-complete**:
create, reparent, list, tree, browse, and reclassify all exist over RabbitMQ. What
remains is the gateway HTTP edge that fronts them, the polymorphic `MediaAsset`
half of [ADR-029](../../adr/029-category-materialized-path-and-polymorphic-media.md),
and the end-to-end coverage that arrives with that HTTP surface.
