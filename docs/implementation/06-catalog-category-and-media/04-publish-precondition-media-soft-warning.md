# 04 — The publish-time media soft warning

This document records how publishing a product surfaces a **recommendation** that
the product carry at least one picture — without ever blocking the publish. When a
product is published and neither it nor any of its variants has an active
`MediaAsset`, the publish response carries a `warnings[]` entry; the product is
published regardless. This is the deliberate counterpart to the **hard** price
gate documented in
[../03-pricing-price-and-tax-category/04-publish-precondition-hard-fail.md](../03-pricing-price-and-tax-category/04-publish-precondition-hard-fail.md)
and enforced in the same use case: a price-less product is *blocked* from
publishing, a media-less one is merely *flagged*.

The design is fixed in
[ADR-029 §7](../../adr/029-category-materialized-path-and-polymorphic-media.md);
the warn-in-the-use-case pattern it follows is
[ADR-025 §6](../../adr/025-catalog-product-and-variant-aggregate.md) (a
cross-aggregate recommendation the domain cannot see lives in the application
layer); the response-shape change is a contracts change per
[ADR-005](../../adr/005-split-shared-common-into-bounded-libs.md). The polymorphic
`MediaAsset` aggregate this check reads is the subject of the sibling
[03 — Polymorphic media assets](./03-media-asset-polymorphism.md).

## 1. Where the recommendation comes from: "recommended, not strict"

A storefront product page that ships with no image looks broken to a shopper even
though nothing technically *is* broken — the product has a name, a price, a
variant to buy. So "a published product should have a picture" is real merchandising
advice, but it is **advice**, not an invariant. Two things follow from that single
distinction:

- It must **not** prevent publishing. A catalog manager who publishes a product
  whose photography is still in flight has made a legitimate choice; the system's
  job is to tell them, not to overrule them.
- It must still be **visible**. A recommendation nobody sees is the same as no
  recommendation. So it rides back in the publish response where the operator (or
  the UI) that triggered the publish will see it immediately.

That is exactly a **soft warning**: surfaced, never enforced.

## 2. Why a response warning, not a 409 — the contrast with the price gate

The publish use case already enforces one cross-aggregate precondition as a **hard
gate**: every variant must have an in-effect price in the default currency, or the
publish fails with `409 PRODUCT_PUBLISH_REQUIRES_PRICE` and the product stays
`draft`. Media is handled the opposite way. The difference is not arbitrary — it
tracks what *breaks* if the precondition is unmet:

| Precondition | Unmet consequence | Treatment |
| --- | --- | --- |
| ≥1 active price per variant | **Checkout breaks** — there is no amount to charge; an order line cannot be priced | **Hard 409, blocks publish** |
| ≥1 active media asset | **The page looks bare** — every downstream flow still works | **Soft `warnings[]`, publish proceeds** |

A price-less active product is a latent production incident: a shopper can reach a
buy button that cannot complete. A media-less active product is a cosmetic gap. The
system blocks the one that would corrupt a downstream flow and merely flags the one
that is only unpolished. Collapsing both into a 409 would make the catalog
needlessly rigid; collapsing both into a warning would let un-purchasable products
go live. Two strengths for two different costs.

## 3. Why the check runs *after* the save

The probe runs **after** `repository.save(product)` — after the product is already
`active`. At that point the check is *provably unable* to change the publish
outcome: there is no longer an outcome to change. This ordering is the mechanism
that guarantees the "never blocks" promise. If the media read were placed *before*
`product.publish()`, a future edit could turn it into a gate by accident (add a
`throw`, and suddenly a media-less product fails to publish). By running it last,
on the already-committed aggregate, the warning is structurally incapable of
becoming a block — the same reasoning the
[ADR-025 §6](../../adr/025-catalog-product-and-variant-aggregate.md) seam uses, and
the reason the domain `Product.publish()` is left completely untouched.

The sequence in `publish-product.use-case.ts`:

1. Load the product (`404` if missing).
2. **Hard** price gate via `ACTIVE_PRICE_PROBE` (`409` on a price-less variant).
3. `product.publish()` — the domain transition (rejects a non-draft / variant-less
   product).
4. `repository.save(product)` — the product is now `active`.
5. Drain `ProductPublishedEvent`, best-effort emit `catalog.product.published`.
6. **Soft** media probe → assemble `warnings[]` → return the view.

Steps 2 and 3 can still reject. Steps 5 and 6 cannot — both are best-effort and
post-commit.

## 4. The structured `{ code, message }` shape

The warning is not a bare string. It is a `PublishWarningView`:

```ts
class PublishWarningView {
  code: string;     // 'CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA'
  message: string;  // human-displayable sentence
}
```

`code` is the **machine-checkable discriminant** — a storefront can branch on it, a
test can assert it, an operator can grep for it — while `message` is the sentence a
human reads. This mirrors the project's error shape (`{ statusCode, message, code }`):
a stable code plus a displayable message. A bare string would force consumers to
pattern-match prose, which breaks the moment the wording is reworded.

`warnings` itself is `warnings?: PublishWarningView[]` on `ProductView`, and its
*absence* is meaningful. On a clean publish — and on every `register` / `archive`
response, which never runs the media probe — the field is **`undefined`, never an
empty `[]`**. A present-but-empty array would falsely read as "warnings were
evaluated and there were none" on a response that never evaluated them at all. So
the use case attaches the array only when it has a warning to put in it; absence is
the clean signal, exactly as `publishedAt` / `archivedAt` are present only on the
transition that sets them.

### Why the code is *not* a `CatalogErrorCodeEnum` member

`CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA` is declared as a plain exported constant
next to `PublishWarningView` in `libs/contracts/catalog/dto/publish-warning.view.ts`
— deliberately **outside** `CatalogErrorCodeEnum`. The enum is the domain of the
`CatalogRpcExceptionFilter`, which maps **every** member to an HTTP status via a
*total* `Record<CatalogErrorCodeEnum, HttpStatus>`. The media code is not an error:
nothing throws it, no status maps it, it travels on a `200`/`201` body. Folding it
into the error enum would either force a meaningless status mapping or break the
filter's totality guarantee. Keeping it a standalone constant says precisely what it
is — a successful-response signal, not a failure code.

## 5. The one-query probe: `hasActiveForOwners`

The catalog domain cannot see media — `MediaAsset` is a separate aggregate with no
foreign key back to `Product` (see [03](./03-media-asset-polymorphism.md)). So, like
the price gate, the use case asks a repository port. `IMediaAssetRepositoryPort`
gains:

```ts
// True when ANY of the (ownerType, ownerId) pairs has an active media asset.
hasActiveForOwners(owners: { ownerType: MediaOwnerTypeEnum; ownerId: number }[]): Promise<boolean>;
```

The publish use case builds the owner set as **the product owner plus one
`product-variant` owner per persisted variant**, and asks the question once:

```ts
const owners = [
  { ownerType: MediaOwnerTypeEnum.PRODUCT, ownerId: productId },
  ...saved.variants.map((v) => ({ ownerType: MediaOwnerTypeEnum.PRODUCT_VARIANT, ownerId: v.id })),
];
const hasActiveMedia = await this.mediaRepository.hasActiveForOwners(owners);
```

The recommendation is "the product *or any of its variants* has a picture", so a
single hero image on the product satisfies it, and so does a photo on just one
variant. The TypeORM implementation is **one** SQL round-trip — an owner-pair tuple
`IN`-list filtered to `status = 'active'` with `LIMIT 1` — not a fan-out of
per-variant `listByOwner` calls:

```sql
SELECT 1 AS present
  FROM media_asset
 WHERE (owner_type, owner_id) IN ((?, ?), (?, ?), …)
   AND status = 'active'
 LIMIT 1
```

The placeholder string is generated from the owner *count* (never from a value), and
every owner field is a driver-bound parameter — the parameterized-SQL stance the
media `reorder` and the active-price probe both take. `LIMIT 1` makes it an
existence check: the first matching row answers the question.

## 6. The probe's failure-swallowing stance

The probe is wrapped in `try/catch`. If the media read throws (a transient DB
hiccup), the failure is **warn-logged and swallowed** — no warning is emitted, the
publish is unaffected, and the use case returns the normal active-product view:

```ts
try {
  const hasActiveMedia = await this.mediaRepository.hasActiveForOwners(owners);
  if (!hasActiveMedia) { /* attach the warning, warn-log */ }
} catch (err) {
  this.logger.warn({ err, correlationId, productId }, 'Media soft-warning probe failed; …');
  // no warning, publish unaffected
}
```

This is the same stance the best-effort `catalog.product.published` event emit
takes one step earlier: a recommendation must **never be able to fail a publish**
that has already committed. A swallowed probe is preferable to a spurious warning —
on a probe failure we cannot prove media is absent, so we say nothing rather than
cry wolf. The product is already active; nothing about a recommendation can or
should undo that.

## 7. How a storefront / operator consumes the field

The gateway publish route is a thin pass-through of `ProductView`, so the field
reaches HTTP with **no gateway change** — the moment the microservice populates
`warnings`, it appears in the publish response body. A consumer reads it like so:

```jsonc
// POST /api/catalog/products/42/publish → 200
{
  "id": 42, "name": "Aeron Chair", "slug": "aeron-chair", "status": "active",
  "publishedAt": "2026-06-12T10:00:00.000Z",
  "warnings": [
    {
      "code": "CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA",
      "message": "Product #42 has no active media asset; publishing proceeded — attaching at least one image is recommended."
    }
  ]
}
```

A catalog admin UI surfaces the `message` as a non-blocking banner ("Published —
heads up: no images yet") and can offer a one-click "attach media" affordance keyed
off the `code`. A clean publish omits `warnings` entirely, so the UI shows nothing.
Because the code is stable, automated catalog-health tooling can scan for published
products that ever returned `CATALOG_PRODUCT_PUBLISH_NO_ACTIVE_MEDIA` and queue them
for a photography pass — the warning is durable signal, not just a one-time toast.

## 8. What stays untouched

- **`Product.publish()`** — the domain transition is unchanged; it still enforces
  only what the aggregate can see (draft state, ≥1 variant). The cross-aggregate
  recommendation lives entirely in the use case (ADR-025 §6).
- **The hard price gate** — `ACTIVE_PRICE_PROBE` and
  `PRODUCT_PUBLISH_REQUIRES_PRICE` are unchanged and still block.
- **The event emit** — `catalog.product.published` still fires best-effort
  post-commit; the soft warning is orthogonal to it.
- **The gateway** — no route, DTO, or serialization change; the optional field
  flows through the existing thin pass-through.

The whole change is one DTO addition (`PublishWarningView` + the
`warnings?` field), one repository-port helper (`hasActiveForOwners` + its TypeORM
implementation), and the use-case probe — nothing else moves.
