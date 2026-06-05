import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { PricingDomainException, PricingErrorCodeEnum } from '../domain';

// Maps each pricing domain error code onto the HTTP status the gateway should
// surface. HTTP status is a transport concern, so the table lives here in the
// presentation layer — never in the transport-free domain (ADR-026, mirroring the
// catalog filter). The mapping is a *total* `Record` keyed on the enum, so it is
// exhaustive at compile time: a new `PricingErrorCodeEnum` member fails the build
// until it is given a status.
const PRICING_ERROR_STATUS: Record<PricingErrorCodeEnum, HttpStatus> = {
  // Malformed-input invariants → 400. Normally caught by the gateway request DTOs
  // first; this is the backstop for the directly-reachable RMQ path.
  [PricingErrorCodeEnum.PRICE_AMOUNT_INVALID]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.PRICE_CURRENCY_INVALID]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.PRICE_INTERVAL_INVALID]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.PRICE_VALID_FROM_IN_PAST]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.PRICE_PRIORITY_INVALID]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.TAX_CATEGORY_CODE_INVALID]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.TAX_CATEGORY_NAME_REQUIRED]: HttpStatus.BAD_REQUEST,

  // Conflicts with current state → 409: the request is well-formed but clashes
  // with what is already persisted (an open price already starts at/after the
  // requested start, or a tax-category code is taken).
  [PricingErrorCodeEnum.PRICE_SCHEDULE_CONFLICT]: HttpStatus.CONFLICT,
  [PricingErrorCodeEnum.TAX_CATEGORY_CODE_TAKEN]: HttpStatus.CONFLICT,

  // Lookup misses → 404.
  [PricingErrorCodeEnum.TAX_CATEGORY_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [PricingErrorCodeEnum.VARIANT_NOT_FOUND]: HttpStatus.NOT_FOUND,
};

// Terminates a `PricingDomainException` into the wire error shape the gateway's
// `throwRpcError` understands — `{ statusCode, message, code }`. Without this the
// raw domain exception reaches the gateway with no `statusCode`, so every pricing
// failure collapses to a 500 (ADR-026). Plain `Error`s (genuinely unexpected
// invariant breaches) are deliberately NOT caught here — they have no error code
// and stay 500.
@Catch(PricingDomainException)
export class PricingRpcExceptionFilter implements RpcExceptionFilter<PricingDomainException> {
  public catch(exception: PricingDomainException): Observable<never> {
    const statusCode = PRICING_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    // The errored stream value is what the RMQ client receives as the rejection
    // payload (the same channel the catalog filter uses).
    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
    }));
  }
}
