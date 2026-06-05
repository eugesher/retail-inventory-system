import { DomainException } from '@retail-inventory-system/common';

// Stable, greppable codes for every pricing domain invariant violation, plus the
// repository-level rejections the pricing write use cases raise. The code is the
// part a future pricing RPC exception filter maps onto an HTTP status + wire
// error shape (`{ statusCode, message, code }`); the domain itself stays
// transport-free. Mirrors `CatalogErrorCodeEnum` (ADR-025).
export enum PricingErrorCodeEnum {
  // Price invariants (enforced in the `Price` model).
  PRICE_AMOUNT_INVALID = 'PRICING_PRICE_AMOUNT_INVALID',
  PRICE_CURRENCY_INVALID = 'PRICING_PRICE_CURRENCY_INVALID',
  PRICE_INTERVAL_INVALID = 'PRICING_PRICE_INTERVAL_INVALID',
  PRICE_VALID_FROM_IN_PAST = 'PRICING_PRICE_VALID_FROM_IN_PAST',
  PRICE_PRIORITY_INVALID = 'PRICING_PRICE_PRIORITY_INVALID',
  // Write-path scheduling conflict surfaced by `SetPriceUseCase`: a new row
  // cannot start at-or-before the existing open row for the scope (there is no
  // cancel/reschedule flow in this capability). Raised by the use case, not the
  // `Price` model — the aggregate cannot see the other open row.
  PRICE_SCHEDULE_CONFLICT = 'PRICING_PRICE_SCHEDULE_CONFLICT',
  // TaxCategory invariants (enforced in the `TaxCategory` model).
  TAX_CATEGORY_CODE_INVALID = 'PRICING_TAX_CATEGORY_CODE_INVALID',
  TAX_CATEGORY_NAME_REQUIRED = 'PRICING_TAX_CATEGORY_NAME_REQUIRED',
  // Repository-level rejections surfaced by the write use cases (later tasks).
  // The aggregate cannot see other rows, so global `code` uniqueness, tax-category
  // existence, and variant existence are pre-checked through the repository port
  // and raised with these codes (the UNIQUE / FK constraints remain the hard
  // guard). Same typed-code channel as the invariant codes above — the
  // presentation layer maps the code to an HTTP status (ADR-025).
  TAX_CATEGORY_CODE_TAKEN = 'PRICING_TAX_CATEGORY_CODE_TAKEN',
  TAX_CATEGORY_NOT_FOUND = 'PRICING_TAX_CATEGORY_NOT_FOUND',
  VARIANT_NOT_FOUND = 'PRICING_VARIANT_NOT_FOUND',
}

// The pricing bounded context's single concrete `DomainException` subclass —
// the same one-throwable-per-context shape the catalog context introduced
// (ADR-025). A typed `code` from `PricingErrorCodeEnum` satisfies the base's
// abstract `code` contract; callers match on the code, never the message.
export class PricingDomainException extends DomainException {
  public readonly code: PricingErrorCodeEnum;

  constructor(code: PricingErrorCodeEnum, message: string) {
    super(message);
    this.code = code;
  }
}
