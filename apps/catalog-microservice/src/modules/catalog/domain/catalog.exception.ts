import { DomainException } from '@retail-inventory-system/common';

// Stable, greppable codes for every catalog domain invariant violation. The
// code is the part a later use-case/presentation layer can map onto an HTTP
// status or a wire error shape; the domain itself stays transport-free.
export enum CatalogErrorCodeEnum {
  PRODUCT_NAME_REQUIRED = 'CATALOG_PRODUCT_NAME_REQUIRED',
  PRODUCT_SLUG_REQUIRED = 'CATALOG_PRODUCT_SLUG_REQUIRED',
  PRODUCT_INVALID_STATE_TRANSITION = 'CATALOG_PRODUCT_INVALID_STATE_TRANSITION',
  PRODUCT_PUBLISH_REQUIRES_VARIANT = 'CATALOG_PRODUCT_PUBLISH_REQUIRES_VARIANT',
  VARIANT_SKU_REQUIRED = 'CATALOG_VARIANT_SKU_REQUIRED',
  VARIANT_OPTION_VALUES_REQUIRED = 'CATALOG_VARIANT_OPTION_VALUES_REQUIRED',
  VARIANT_WEIGHT_INVALID = 'CATALOG_VARIANT_WEIGHT_INVALID',
  VARIANT_DIMENSIONS_INVALID = 'CATALOG_VARIANT_DIMENSIONS_INVALID',
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
