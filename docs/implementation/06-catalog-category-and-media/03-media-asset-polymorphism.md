# 03 — Polymorphic media assets and the attach / reorder / detach / list operations

This document records how the catalog attaches **media** — images, videos, and
documents — to the things it sells, and the four operations that maintain a
product's or variant's media strip. A single `MediaAsset` aggregate is
**polymorphic** over its owner: one `media_asset` table carries assets that hang
off either a `product` or a single `product_variant`, discriminated by an
`owner_type` column rather than split across two owner-specific join tables. It is
a third write aggregate inside the existing catalog module, a sibling of `Product`
and `Category` — not a new bounded context, no new deployable or queue. The design
is fixed in
[ADR-029](../../adr/029-category-materialized-path-and-polymorphic-media.md); this
doc is the implementation narrative.

All four operations are RPCs on `catalog_queue`, served by a new catalog
`media.controller.ts` alongside the product and category controllers. There is
**no gateway HTTP surface yet** — these RPCs are reachable from an RMQ client and
the unit suite; the HTTP edge is a later catalog capability.

| RPC key | Use case | Response |
| --- | --- | --- |
| `catalog.media.attach` | `AttachMediaUseCase` | `MediaAssetView` |
| `catalog.media.reorder` | `ReorderMediaUseCase` | `MediaAssetView[]` |
| `catalog.media.detach` | `DetachMediaUseCase` | `MediaAssetView` |
| `catalog.media.list` | `ListMediaUseCase` | `MediaAssetView[]` |

Like the category surface, the media capability emits **no events** — attach,
reorder, and detach are state changes with no cross-service consumer today, and
list is a read.

## 1. One polymorphic table vs. per-owner join tables

A media asset belongs to exactly one owner, but that owner can be one of two kinds:
a product (the gallery on a product page) or a single variant (the photo of the
*red, size-M* shirt specifically). Two shapes were on the table:

1. **Two owner-specific tables** — `product_media` and `product_variant_media`,
   each with a real foreign key to its owner. Referential integrity is enforced by
   the database, but every read that wants "all media for this thing" has to know
   which table to hit, and any cross-owner query (an admin media browser, a future
   `category_media`) multiplies the tables.
2. **One polymorphic table** — a single `media_asset` with an `(owner_type,
   owner_id)` pair naming the owner. One read path, one mapper, one repository;
   adding a third owner kind later is a new enum value, not a new table.

We chose **one polymorphic table**. The cost is the part the database can no longer
do for us: a foreign key cannot target two tables, so `owner_id` carries **no FK**.
That trade-off and its compensation are the subject of the next section.

```sql
CREATE TABLE media_asset (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  owner_type ENUM('product','product-variant') NOT NULL,
  owner_id   BIGINT UNSIGNED NOT NULL,            -- no FK: polymorphic owner
  uri        VARCHAR(1024) NOT NULL,
  type       ENUM('image','video','document') NOT NULL,
  alt_text   VARCHAR(255) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status     ENUM('active','archived') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP NULL
);
CREATE INDEX IDX_MEDIA_ASSET_OWNER ON media_asset (owner_type, owner_id, sort_order);
```

The same polymorphic-owner pattern, no-FK and all, is already in the codebase: the
retail `address` table is polymorphic over `customer` / `order`
([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)). The materialized
`path` on `category` is a different answer to a different question (a *hierarchy*,
not a *polymorphic owner*); see
[01 — Category hierarchy and the materialized path](01-category-hierarchy-and-materialized-path.md).

## 2. The no-FK trade-off and the use-case existence check

Without a foreign key, the database will happily insert a `media_asset` row whose
`owner_id` points at a product that does not exist. Nothing in the schema stops a
dangling owner reference. The compensation is moved up one layer: the **attach use
case** is the guard.

`AttachMediaUseCase` probes the owner against the table its `owner_type` names
before it writes anything:

- `owner_type = 'product'` → `ICatalogRepositoryPort.findById(ownerId)`
- `owner_type = 'product-variant'` → `ICatalogRepositoryPort.findVariantById(ownerId)`

A miss raises `MEDIA_OWNER_NOT_FOUND` (404). This is the **only** media use case
that touches a second repository seam — it injects both `MEDIA_ASSET_REPOSITORY`
(for the write) and `CATALOG_REPOSITORY` (for the owner probe). An **archived**
owner is still a valid target: an archived product/variant stays resolvable
(soft-delete is via `status`, [ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)),
so attaching media to it is allowed.

The index `IDX_MEDIA_ASSET_OWNER (owner_type, owner_id, sort_order)` is the second
half of the compensation. Every media read is owner-scoped — list the owner's
assets, find the owner's max slot, reorder the owner's strip — so the composite
index turns each into a covered range scan instead of a full-table scan, and its
trailing `sort_order` column means the list read comes back pre-ordered.

The domain re-validates the owner kind too: `MediaAsset` rejects an `ownerType`
outside `MediaOwnerTypeEnum` (`MEDIA_OWNER_TYPE_INVALID`) and a non-positive
`ownerId` (`MEDIA_OWNER_ID_INVALID`). An RPC payload can arrive directly on the
queue without passing through a gateway DTO, so the aggregate cannot assume its
input was pre-validated.

## 3. The opaque-URI policy

`uri` is an **already-uploaded reference**. The catalog does not upload anything,
does not issue signed URLs, does not rewrite CDN hostnames, and — critically —
does **not** validate the scheme or extension. The domain enforces exactly one
rule on it: it must be non-empty (`MEDIA_URI_REQUIRED`).

`https://cdn.example.com/img/phone.jpg` and `s3://bucket/key/manual.pdf` are the
**documented expectations** for what a `uri` looks like, not domain rules. An
operator (or a future upload pipeline) uploads the bytes somewhere and hands the
catalog the resulting string; the catalog stores it verbatim. Treating the URI as
opaque keeps this capability small and keeps the upload concern — multipart
handling, virus scanning, thumbnail generation, signed-URL expiry — out of the
catalog entirely, to land as a separate capability when it is needed. The
`type` enum (`image` / `video` / `document`) is what a store-front keys on to
decide how to render the asset; it is a classification of the resource, not a
constraint derived from the URI.

## 4. `sortOrder`: append-at-the-end, atomic reorder, no compaction

A media strip is **ordered** — the first image is the hero shot. Order is carried
by the integer `sort_order`, and three rules govern it.

### Append at `max + 1`, counting archived rows

`AttachMediaUseCase` computes the new asset's slot as
`(maxSortOrder ?? -1) + 1`: the first asset for an owner lands at `0`, and each
subsequent attach goes to the end of the strip. The subtle part is that
`IMediaAssetRepositoryPort.maxSortOrder` takes `MAX(sort_order)` across **all** of
the owner's rows — **archived included**. If it counted only active rows, then
after detaching the highest-slotted asset the next append would reuse that slot,
and a later operation could find two assets fighting over one position. Counting
archived rows keeps the slot sequence **monotonic** per owner: a number, once
handed out, is never handed out again.

`maxSortOrder` is owner-scoped, so attaching to owner B never disturbs owner A's
strip — each owner's slots are computed only from its own rows.

### Reorder is an atomic, permutation-only bulk write

`ReorderMediaUseCase` takes `mediaIdsInOrder` — the owner's active media, in the
desired order — and sets each asset's `sort_order` to its array index. Two
properties make it safe:

- **Permutation-only.** The id list must be an **exact permutation** of the
  owner's current active set: same ids, no duplicates, no omissions, no foreign or
  archived ids. The use case loads the active set and checks set-equality before
  touching the repository; anything else is `MEDIA_REORDER_SET_MISMATCH` (409), and
  the repository's `reorder` is **never called**. Partial reorder is not a thing —
  you cannot move three of an owner's five assets and leave the other two implied.
- **Atomic.** `MediaAssetTypeormRepository.reorder` runs every slot UPDATE inside
  **one** `manager.transaction(...)` — the same transaction-inside-the-repository
  pattern as `CategoryTypeormRepository.reparentSubtree` and
  `PricingTypeormRepository.appendPrice`, no application-level `ITransactionPort`.
  Either every slot moves or none does, so a crash mid-reorder cannot leave the
  strip half-renumbered. Each UPDATE is parameterized and owner-scoped
  (`WHERE id = ? AND owner_type = ? AND owner_id = ?`) — belt-and-braces against a
  stray id touching another owner.

### No compaction on detach

Detaching the asset at slot 1 of a 0-1-2 strip leaves slots 0 and 2 — there is **no
renumbering** to close the gap. Browse sorts on `sort_order ASC`, so a `0, 2`
sequence renders in exactly the same order as `0, 1`; relative order is all that
matters, and compaction would be churn for no visible effect. A fresh `reorder`
re-densifies the slots if anyone cares.

## 5. Detach is a state-guarded status flip, not a delete

`DetachMediaUseCase` does **not** delete the row. It flips `status` from `active`
to `archived` (`MediaAsset.archive()`) and saves. The row survives because
anything that captured the media id historically — a cached page render, an
audit log, a future order-line thumbnail snapshot — must still resolve it; a hard
delete would dangle those references.

Detach is **state-guarded, not idempotent**. A second detach of an
already-archived asset is an illegal transition: `MediaAsset.archive()` throws
`MEDIA_INVALID_STATE_TRANSITION` (409). This is a deliberate contrast with the
idempotent reclassify writes of
[02 — Product↔category membership](02-product-categories-join.md): a reclassify
*detach* of an absent membership is a silent no-op because membership is a set
("make sure this product is not in this category"), whereas a media detach is a
**lifecycle transition** on a specific row ("archive *this* asset"), and asking to
archive something already archived is a conflict worth surfacing. The same
state-guarded shape governs `Category.archive()` and `Product.archive()`.

`ListMediaUseCase` reads only `status = 'active'` rows, so a detached asset
vanishes from the store-front the moment it is archived, while the row lingers for
historical resolution.

## 6. The list read has no owner-existence probe

Unlike attach, `ListMediaUseCase` does **not** check that the owner exists. An
unknown owner yields `[]`, not a 404. This is the public-browse zero-answer
convention the inventory per-variant stock read established: a store-front renders
a product page and asks for its media as one of many parallel reads, and a 404 on
"this product happens to have no media yet" would force every render into error
handling. An empty strip and a non-existent owner are indistinguishable to a
browser, and that is the correct answer for a read — both mean "nothing to show."

One `IMediaListQuery` (`{ ownerType, ownerId }`) serves both the product- and
variant-scoped reads; the `ownerType` discriminator selects which. When the
gateway HTTP surface lands, the two GETs (`/products/:id/media`,
`/variants/:id/media`) will both funnel into this one query.

## 7. Layering and where each rule lives

The capability follows the per-module hexagonal layout
([ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md) /
[ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)):

- **Domain** (`media-asset.model.ts`, `media-asset-status.enum.ts`) — the
  invariants (non-empty uri, enum-member owner/type, non-negative integer slot),
  the `archive()` / `changeSortOrder()` mutators, and the `MediaAssetStatusEnum`
  lifecycle. Framework-free; records no events. The status enum lives here, not in
  `libs/contracts`, because it is an internal lifecycle concept — the wire carries
  its raw string. The two **owner-type / asset-type** enums, by contrast, ride the
  RPC payloads and the view, so they live in `libs/contracts/catalog/enums`.
- **Application** (`application/ports/media-asset.repository.port.ts`, the four
  use cases, `media-asset-view.factory.ts`) — the orchestration and the
  `MEDIA_ASSET_REPOSITORY` seam (a third port alongside `CATALOG_REPOSITORY` /
  `CATEGORY_REPOSITORY`, one port per aggregate). Domain types only; no `typeorm`
  leak.
- **Infrastructure** (`media-asset.entity.ts`, `media-asset.mapper.ts`,
  `media-asset-typeorm.repository.ts`) — the only `@InjectRepository(MediaAssetEntity)`
  site, the BIGINT-string coercion in the mapper (mysql2 surfaces non-PK BIGINTs as
  strings), and the one-transaction reorder.
- **Presentation** (`media.controller.ts`) — four thin `@MessagePattern` handlers.
  The module-wide `CatalogRpcExceptionFilter` (registered via `APP_FILTER`) maps
  the nine `MEDIA_*` codes onto HTTP statuses, so the controller needs no error
  wiring of its own.

### The `MEDIA_*` rejection matrix

| Code | HTTP | Raised by | When |
| --- | --- | --- | --- |
| `MEDIA_URI_REQUIRED` | 400 | model | empty uri |
| `MEDIA_TYPE_INVALID` | 400 | model | type outside the enum |
| `MEDIA_OWNER_TYPE_INVALID` | 400 | model | ownerType outside the enum |
| `MEDIA_OWNER_ID_INVALID` | 400 | model | non-positive / non-integer ownerId |
| `MEDIA_SORT_ORDER_INVALID` | 400 | model | negative / non-integer slot |
| `MEDIA_NOT_FOUND` | 404 | detach UC | detach target id missing |
| `MEDIA_OWNER_NOT_FOUND` | 404 | attach UC | attach owner missing in its table |
| `MEDIA_INVALID_STATE_TRANSITION` | 409 | model (`archive`) | second detach |
| `MEDIA_REORDER_SET_MISMATCH` | 409 | reorder UC | id set is not an exact permutation |

## 8. What is deliberately deferred

- **The publish "≥1 active media" soft warning** — a later catalog capability adds
  a `warnings[]` entry to the publish response when a product has no active media,
  a deliberate contrast with the hard `PRODUCT_PUBLISH_REQUIRES_PRICE` gate
  (ADR-029 §7). It is a soft signal, never a block; it lives in the publish use
  case (the domain cannot see media).
- **The gateway HTTP surface** for the four media RPCs (and the category RPCs) — a
  later catalog capability, with its `.http` file.
- **Upload pipelines, signed URLs, CDN rewriting, thumbnails** — the URI is opaque
  today (§3); the upload concern is a separate future capability.
- **End-to-end tests and seed data** for media — they arrive with the gateway edge.
