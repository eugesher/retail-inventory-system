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
