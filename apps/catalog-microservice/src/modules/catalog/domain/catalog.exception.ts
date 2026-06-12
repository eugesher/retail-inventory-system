import { DomainException } from '@retail-inventory-system/common';

// Stable, greppable codes for every catalog domain invariant violation. The
// code is the part the presentation-layer `CatalogRpcExceptionFilter` maps onto
// an HTTP status + wire error shape (`{ statusCode, message, code }`); the domain
// itself stays transport-free.
export enum CatalogErrorCodeEnum {
  PRODUCT_NAME_REQUIRED = 'CATALOG_PRODUCT_NAME_REQUIRED',
  PRODUCT_SLUG_REQUIRED = 'CATALOG_PRODUCT_SLUG_REQUIRED',
  PRODUCT_INVALID_STATE_TRANSITION = 'CATALOG_PRODUCT_INVALID_STATE_TRANSITION',
  PRODUCT_PUBLISH_REQUIRES_VARIANT = 'CATALOG_PRODUCT_PUBLISH_REQUIRES_VARIANT',
  // Publish precondition the domain cannot see: every variant must have an
  // in-effect Price in the configured default currency. Enforced in the publish
  // use case via the active-price probe (not the `Product` model — price is a
  // cross-aggregate fact), and mapped to 409 by the presentation filter (ADR-025
  // / ADR-026). A well-formed request the resource state forbids — a missing
  // active price — not malformed input.
  PRODUCT_PUBLISH_REQUIRES_PRICE = 'CATALOG_PRODUCT_PUBLISH_REQUIRES_PRICE',
  VARIANT_SKU_REQUIRED = 'CATALOG_VARIANT_SKU_REQUIRED',
  VARIANT_OPTION_VALUES_REQUIRED = 'CATALOG_VARIANT_OPTION_VALUES_REQUIRED',
  VARIANT_WEIGHT_INVALID = 'CATALOG_VARIANT_WEIGHT_INVALID',
  VARIANT_DIMENSIONS_INVALID = 'CATALOG_VARIANT_DIMENSIONS_INVALID',
  // Repository-level rejections surfaced by the write use cases. The aggregate
  // cannot see other aggregates, so global slug/sku uniqueness and parent
  // existence are pre-checked through the repository port and raised with these
  // codes (the UNIQUE constraints remain the hard guard). Same typed-code
  // channel as the invariant codes above — the presentation layer maps the code
  // to an HTTP status (ADR-025).
  PRODUCT_NOT_FOUND = 'CATALOG_PRODUCT_NOT_FOUND',
  PRODUCT_SLUG_TAKEN = 'CATALOG_PRODUCT_SLUG_TAKEN',
  VARIANT_SKU_TAKEN = 'CATALOG_VARIANT_SKU_TAKEN',
  // Read-path not-found: `catalog.variant.get` for an unknown variant id. A
  // distinct code from `PRODUCT_NOT_FOUND` so the presentation layer can map the
  // variant lookup to its own 404 without conflating it with a product miss.
  VARIANT_NOT_FOUND = 'CATALOG_VARIANT_NOT_FOUND',

  // Category invariants enforced in the `Category` aggregate. The slug rule is
  // STRICTER than `Product.slug` (kebab-case, not merely non-empty) because the
  // category slug is a materialized-path segment — a malformed slug would
  // corrupt every descendant's `path` (ADR-029). The state-transition and cycle
  // codes are 409s (a well-formed request the resource state forbids).
  CATEGORY_NAME_REQUIRED = 'CATALOG_CATEGORY_NAME_REQUIRED',
  CATEGORY_SLUG_INVALID = 'CATALOG_CATEGORY_SLUG_INVALID',
  CATEGORY_SORT_ORDER_INVALID = 'CATALOG_CATEGORY_SORT_ORDER_INVALID',
  CATEGORY_INVALID_STATE_TRANSITION = 'CATALOG_CATEGORY_INVALID_STATE_TRANSITION',
  CATEGORY_CYCLE = 'CATALOG_CATEGORY_CYCLE',
  // Repository-level rejections surfaced by the category use cases (which arrive
  // in the create/reparent work). The aggregate cannot see other aggregates, so
  // global slug uniqueness, parent existence, and target-category lookup are
  // pre-checked through the repository port and raised with these codes (the
  // UNIQUE constraint remains the hard guard). Landing the codes + the filter
  // mappings now keeps the filter total and the next session contract-only.
  CATEGORY_NOT_FOUND = 'CATALOG_CATEGORY_NOT_FOUND',
  CATEGORY_PARENT_NOT_FOUND = 'CATALOG_CATEGORY_PARENT_NOT_FOUND',
  CATEGORY_SLUG_TAKEN = 'CATALOG_CATEGORY_SLUG_TAKEN',
  CATEGORY_ARCHIVED = 'CATALOG_CATEGORY_ARCHIVED',

  // MediaAsset invariants enforced in the `MediaAsset` aggregate (the domain
  // re-validates what the gateway DTO also checks, because an RPC payload can
  // arrive directly without the gateway). The `uri` is opaque — there is NO
  // scheme allow-list (`MEDIA_URI_REQUIRED` is a non-empty check only); the owner
  // and asset type are validated against the wire enums; `sortOrder` must be a
  // non-negative integer (it is a slot index). All four are 400s (malformed
  // input). ADR-029 §4.
  MEDIA_URI_REQUIRED = 'CATALOG_MEDIA_URI_REQUIRED',
  MEDIA_TYPE_INVALID = 'CATALOG_MEDIA_TYPE_INVALID',
  MEDIA_OWNER_TYPE_INVALID = 'CATALOG_MEDIA_OWNER_TYPE_INVALID',
  MEDIA_OWNER_ID_INVALID = 'CATALOG_MEDIA_OWNER_ID_INVALID',
  MEDIA_SORT_ORDER_INVALID = 'CATALOG_MEDIA_SORT_ORDER_INVALID',
  // Repository / use-case level media rejections. `MEDIA_NOT_FOUND` is the detach
  // miss (404); `MEDIA_OWNER_NOT_FOUND` is the attach owner-existence miss (404 —
  // the polymorphic owner has no FK, so the use case probes the product/variant
  // table by hand). `MEDIA_INVALID_STATE_TRANSITION` is a second detach of an
  // already-archived asset (409); `MEDIA_REORDER_SET_MISMATCH` is a reorder whose
  // id set is not an exact permutation of the owner's active media (409 — the bulk
  // reorder is all-or-nothing). ADR-029 §4.
  MEDIA_NOT_FOUND = 'CATALOG_MEDIA_NOT_FOUND',
  MEDIA_OWNER_NOT_FOUND = 'CATALOG_MEDIA_OWNER_NOT_FOUND',
  MEDIA_INVALID_STATE_TRANSITION = 'CATALOG_MEDIA_INVALID_STATE_TRANSITION',
  MEDIA_REORDER_SET_MISMATCH = 'CATALOG_MEDIA_REORDER_SET_MISMATCH',
}

// The catalog bounded context is the first concrete consumer of the
// framework-free `DomainException` base from `libs/common` — the earlier
// aggregates (Order, StockItem) threw plain `Error`. A single concrete class
// carries a typed `code` from `CatalogErrorCodeEnum`, satisfying the base's
// abstract `code` contract while keeping one throwable per bounded context
// (ADR-025).
export class CatalogDomainException extends DomainException {
  public readonly code: CatalogErrorCodeEnum;

  constructor(code: CatalogErrorCodeEnum, message: string) {
    super(message);
    this.code = code;
  }
}
