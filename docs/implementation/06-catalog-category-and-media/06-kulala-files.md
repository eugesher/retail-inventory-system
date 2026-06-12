# Category & Media — end-to-end suites and Kulala HTTP files

This document closes the category/media capability by **locking it end-to-end**.
The HTTP edge added in
[`05-category-and-media-api.md`](05-category-and-media-api.md) (twelve routes under
`/api/catalog`, fronting the ten category/media RPCs described in
[`01-category-hierarchy-and-materialized-path.md`](01-category-hierarchy-and-materialized-path.md),
[`02-product-categories-join.md`](02-product-categories-join.md), and
[`03-media-asset-polymorphism.md`](03-media-asset-polymorphism.md), plus the
publish soft warning of
[`04-publish-precondition-media-soft-warning.md`](04-publish-precondition-media-soft-warning.md))
is now covered by two gateway e2e suites and two runnable Kulala `.http` files.

Together they prove, through the real HTTP surface, every behaviour ADR-029 set
out: the materialized-path subtree rebase, the reparent cycle guard, idempotent
reclassify, the all-or-nothing media reorder, the state-guarded detach, and the
permission gating asserted from the seeded users
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)).

## Artifacts

| Artifact | What it locks |
| --- | --- |
| `test/catalog-categories.e2e-spec.ts` | The category surface through the gateway: hierarchy + paths, reparent + subtree rebase, reclassify + both browse endpoints, the cycle 409, and the 401/403/404/409 gates. |
| `test/catalog-media.e2e-spec.ts` | The polymorphic media surface: attach-appends-in-order, atomic reorder (200 + the mismatch 409), detach as an archive flip (+ the second-detach 409), variant-scoped media, and the 401/403/404/400 gates. |
| `http/catalog-categories.http` | An interactive, top-to-bottom walk of the same category flows, ending in a deliberate cycle-reparent 409. |
| `http/catalog-media.http` | An interactive walk of the media flows + a deliberate mismatch-reorder 409, plus the publish soft-warning demonstration. |

## A prerequisite: the gateway now forwards the typed error code

The catalog microservice already terminates every `CatalogDomainException` into
the wire shape `{ statusCode, message, code }` (its `CatalogRpcExceptionFilter`,
[ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md) §6). The gateway
helper `apps/api-gateway/src/common/utils/throw-rpc-error.util.ts` used to map the
`statusCode` to an HTTP exception but **drop the `code`**, leaving the human
`message` as the only assertable signal. It now **forwards the `code` into the
HTTP error body** — a `409`/`404`/`400`/`403` from any RPC-fronting gateway module
(catalog, inventory, orders, cart — all four RPC filters emit a `code`) carries
`{ statusCode, message, code }`. A non-RPC error (no `code`) keeps the standard
Nest `{ statusCode, message, error }` shape.

This is what lets a client — and these suites/files — branch on a stable,
greppable code (`CATALOG_CATEGORY_CYCLE`, `CATALOG_MEDIA_REORDER_SET_MISMATCH`)
instead of brittle-matching a sentence. The change is additive: no existing
assertion depends on the dropped `error` label.

## E2E suite design

Both suites boot the **API gateway plus the catalog microservice** in-process
(the existing `catalog.e2e-spec.ts` shape), drive everything over HTTP with
`supertest`, and rely only on the seeded products/variants and the seeded logins
(`admin@example.com` / `admin1234` for the `catalog:write` writes;
`customer@example.com` / `customer1234` for the 403 gate). No category or media
**seed rows** are assumed — every fixture is API-created.

### Collision-proofing (why the fixtures look the way they do)

A later session will seed the categories `electronics` / `phones` / `apparel` and
two media rows on product 1. Two rules keep these suites green **both before and
after** that seed lands, and across repeated runs against living infrastructure:

- **Category slugs use the `menswear` family** (`menswear` / `shirts` /
  `trousers` / `oxford` / `clearance`), never the reserved seeded three, and each
  carries a **per-run `Date.now()` suffix** so a second `yarn test:e2e:run`
  against an already-seeded database never trips the `UNIQUE(slug)` constraint.
  Every membership assertion is **relative**: it filters the product's full
  category list down to *this run's* slugs rather than asserting an exact size
  (product 1 accumulates memberships across runs and from the future seed).
- **Media assertions are relative too** — they filter the owner's strip to the
  ids this run created. But the reorder operation needs its request set to be an
  **exact permutation of the owner's active strip**, which relative filtering
  cannot provide. So the media suite **clean-slates** product 1 and variant 1 in
  `beforeAll` (it lists the active strip over the public route and archives each
  asset through the detach route). Afterwards the active strip is exactly what
  the run attaches, the reorder is deterministic, and the suite is immune to both
  prior-run leftovers and the future seed. Because the append slot
  (`max(sort_order)+1`) counts archived rows, the created `sortOrder`s are
  asserted as **strictly ascending**, never as fixed values.

### `catalog-categories.e2e-spec.ts` — scenario inventory

1. **Hierarchy + paths** — create a root, two children, a grandchild; assert each
   `path`, `parentId`, and `status: 'active'`; `?root=true` lists the root but
   not a child; the flat list contains all four; the tree nests
   `shirts → oxford` and `trousers`.
2. **Reparent + subtree rebase** — move `shirts` under a second root `clearance`;
   assert `category.path` and `rewrittenDescendantCount === 1`; read the tree to
   confirm the grandchild `oxford` was rebased onto the new prefix *in the same
   transaction*; demote `shirts` to a root (omitted `newParentSlug`); then restore
   it under `menswear` so the browse scenario reads a meaningful tree.
3. **Reclassify + both browse endpoints** — attach product 1 to `menswear` and
   `shirts`; both `…/products` browses return it (tokenless); re-attaching the
   same slugs is idempotent (200, membership unchanged); detaching `menswear`
   drops the product from that direct browse **but** `?includeDescendants=true`
   on `menswear` still finds it (it stays attached to the descendant `shirts`) —
   the same assertion proves both the descendant-scope expansion and "stays under
   shirts".
4. **Cycle detection** — reparent `menswear` under its own descendant `oxford`,
   and under itself, are both `409` with `code === 'CATALOG_CATEGORY_CYCLE'`.
5. **Gating** — tokenless create `401`; customer token `403`; unknown
   `parentSlug` `404`; reparent of an unknown slug `404`; duplicate slug `409`
   (each conflict/lookup asserted by `code`).

### `catalog-media.e2e-spec.ts` — scenario inventory

1. **Attach appends in order** — attach image/video/document to product 1;
   `sortOrder` is strictly ascending in creation order; the public product-media
   browse returns them in that order (filtered to the created trio).
2. **Reorder is an atomic permutation** — reorder with the trio reversed → `200`,
   and the public browse reflects the reversed order; a non-permutation set (the
   trio plus a foreign id) → `409` with
   `code === 'CATALOG_MEDIA_REORDER_SET_MISMATCH'`, writing nothing.
3. **Detach is a state-guarded flip** — detach the middle asset → `200` with
   `status: 'archived'`; the browse returns the two survivors in their preserved
   relative order; a second detach of the same id → `409` with
   `code === 'CATALOG_MEDIA_INVALID_STATE_TRANSITION'`.
4. **Variant-scoped media** — attach to variant 1; the variant browse returns it;
   the product strip is unchanged (media are owner-scoped by `(ownerType,
   ownerId)`).
5. **Gating + validation** — tokenless attach `401`; customer token `403`;
   unknown owner id `404` (`CATALOG_MEDIA_OWNER_NOT_FOUND`); a bad `type`, a bad
   `ownerType`, and an empty `uri` are each `400` at the DTO edge.

## Kulala `.http` files

The `.http` files follow the conventions of the existing `http/catalog.http` and
`http/pricing.http`: `@baseUrl = {{ENV_BASE_URL}}` (resolved from
`http/http-client.env.json`), `###` separators, a `# @name <id>` per request,
header comments citing the **gateway controller path** plus the body/query shape,
a `# Prereqs:` block (compose up → migrate → seed → start; run `login` first to
capture `@accessToken`), and **chained captures** so the file runs top-to-bottom
without manual edits. They use the `workshop-*` slug/URI family so they never
collide with the seeded or e2e fixtures.

Both files are **manual demonstration tools** (a human runs them against a fresh
seed and reads the responses), so — unlike the e2e suites — they use fixed slugs
and assume a freshly-seeded stack. The re-run note in each file says to re-seed
with `yarn test:infra:reload` between full runs, because the created slugs and the
single open media strip are stateful.

### `catalog-categories.http`

`login` → create root `workshop`, children `workshop-tools` / `workshop-benches`,
grandchild `workshop-hand-planes` → flat list (`?root=true` and full) → tree →
create second root `workshop-clearance` → reparent `workshop-tools` under it
(showing `rewrittenDescendantCount`) → read the new tree (the grandchild's rebased
path) → demote to root (`newParentSlug: null`) → restore under `workshop` → attach
product 1 to two categories → browse (with and without `?includeDescendants=true`,
tokenless) → detach one → and a final, deliberately-failing **cycle reparent**.

### `catalog-media.http`

`login` → attach three assets to product 1 (capturing the ids) → public browse →
reorder reversed → browse again → the deliberate **mismatch reorder** → detach the
middle → browse again → attach to a variant + variant-media browse. Then, because
media is its natural home, the **publish soft-warning demonstration**: register a
fresh `workshop-easel` product, add a variant, set a price (the *hard* publish
precondition), and publish it **media-less** — the `200` response carries
`warnings: [{ code: 'CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA', message }]` — then
attach an image as the recommended follow-up. (The pre-existing `http/catalog.http`
is left untouched.)

### Why the two expected-409 blocks are included

Each `.http` file ends a sub-flow with a block that is **meant** to fail, clearly
commented as such and placed so it never interrupts the chain above it:

- **Cycle reparent** (categories) — moving a category under its own descendant is
  the canonical illustration of the materialized-path cycle guard; the response
  body's `code: 'CATALOG_CATEGORY_CYCLE'` is the point of the block.
- **Mismatch reorder** (media) — smuggling a foreign id into the reorder set shows
  the all-or-nothing contract: the catalog writes nothing and returns
  `code: 'CATALOG_MEDIA_REORDER_SET_MISMATCH'`. It demonstrates *why* the reorder
  is safe to call optimistically — a wrong set cannot corrupt the strip.

These blocks double as living documentation of the forwarded error `code`: a
reader sees the exact body a client branches on.

## How it was verified

```bash
yarn lint                 # --max-warnings 0, clean
yarn test:unit            # all unit suites green
yarn test:e2e             # infra reload + migrate + seed; 17 suites green,
                          # including the two new ones
yarn test:e2e:run         # the two new suites stay green on a re-run against
                          # living infra (per-run-unique fixtures + clean-slate)
```

Both `.http` files were executed top-to-bottom against a freshly-reset stack: the
category walk produced the expected paths, `rewrittenDescendantCount`, the
`includeDescendants` re-appearance after detach, and the `CATALOG_CATEGORY_CYCLE`
409; the media walk produced the ascending slots, the reversed reorder, the
`CATALOG_MEDIA_REORDER_SET_MISMATCH` and `CATALOG_MEDIA_INVALID_STATE_TRANSITION`
409s, the independent variant strip, and the publish `warnings[]` entry.
