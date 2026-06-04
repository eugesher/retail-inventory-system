import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../domain';

// Maps each catalog domain error code onto the HTTP status the gateway should
// surface. HTTP status is a transport concern, so the table lives here in the
// presentation layer — never in the transport-free domain (ADR-025). The mapping
// is a *total* `Record` keyed on the enum, so it is exhaustive at compile time: a
// new `CatalogErrorCodeEnum` member fails the build until it is given a status.
const CATALOG_ERROR_STATUS: Record<CatalogErrorCodeEnum, HttpStatus> = {
  // Read/lookup misses → 404.
  [CatalogErrorCodeEnum.PRODUCT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [CatalogErrorCodeEnum.VARIANT_NOT_FOUND]: HttpStatus.NOT_FOUND,

  // Uniqueness collisions and lifecycle conflicts → 409: the request is
  // well-formed but conflicts with the current state of the resource (a slug/sku
  // already exists, or a transition is illegal from the current status).
  [CatalogErrorCodeEnum.PRODUCT_SLUG_TAKEN]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.VARIANT_SKU_TAKEN]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.PRODUCT_INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,
  [CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_VARIANT]: HttpStatus.CONFLICT,
  // Publish blocked by a missing active Price: the request is well-formed but the
  // resource state forbids the transition — a 409, the same class as the
  // variant-count and illegal-transition conflicts above (ADR-026).
  [CatalogErrorCodeEnum.PRODUCT_PUBLISH_REQUIRES_PRICE]: HttpStatus.CONFLICT,

  // Malformed input invariants → 400. These are normally caught by the gateway
  // request DTOs first; this is the backstop for the directly-reachable RMQ path.
  [CatalogErrorCodeEnum.PRODUCT_NAME_REQUIRED]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.PRODUCT_SLUG_REQUIRED]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.VARIANT_SKU_REQUIRED]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.VARIANT_OPTION_VALUES_REQUIRED]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.VARIANT_WEIGHT_INVALID]: HttpStatus.BAD_REQUEST,
  [CatalogErrorCodeEnum.VARIANT_DIMENSIONS_INVALID]: HttpStatus.BAD_REQUEST,
};

// Terminates a `CatalogDomainException` into the wire error shape the gateway's
// `throwRpcError` understands — `{ statusCode, message, code }`. Without this the
// raw domain exception reaches the gateway with no `statusCode`, so every catalog
// failure collapses to a 500 (ADR-025). Plain `Error`s (invariant breaches such
// as "persisted variant id missing after save") are deliberately NOT caught here:
// they have no error code, are genuinely unexpected, and stay 500.
@Catch(CatalogDomainException)
export class CatalogRpcExceptionFilter implements RpcExceptionFilter<CatalogDomainException> {
  public catch(exception: CatalogDomainException): Observable<never> {
    const statusCode = CATALOG_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    // The errored stream value is what the RMQ client receives as the rejection
    // payload (the same channel retail's `OrderConfirmPipe` uses via RpcException).
    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
    }));
  }
}
