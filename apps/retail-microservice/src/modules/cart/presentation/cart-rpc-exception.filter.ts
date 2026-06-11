import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { CartDomainException, CartErrorCodeEnum } from '../domain';

// Maps each cart domain error code onto the HTTP status the gateway should
// surface. HTTP status is a transport concern, so the table lives here in the
// presentation layer — never in the transport-free domain (the catalog/inventory
// filter pattern, ADR-025 / ADR-027). The mapping is a *total* `Record` keyed on
// the enum, so it is exhaustive at compile time: a new `CartErrorCodeEnum` member
// fails the build until it is given a status.
const CART_ERROR_STATUS: Record<CartErrorCodeEnum, HttpStatus> = {
  // Malformed-input invariants → 400. Normally caught by the gateway request
  // DTOs first; this is the backstop for the directly-reachable RMQ path.
  [CartErrorCodeEnum.CART_CURRENCY_INVALID]: HttpStatus.BAD_REQUEST,
  [CartErrorCodeEnum.CART_VERSION_INVALID]: HttpStatus.BAD_REQUEST,
  [CartErrorCodeEnum.CART_LINE_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [CartErrorCodeEnum.CART_LINE_VARIANT_INVALID]: HttpStatus.BAD_REQUEST,
  [CartErrorCodeEnum.CART_LINE_PRICE_INVALID]: HttpStatus.BAD_REQUEST,
  [CartErrorCodeEnum.CART_LINE_CURRENCY_REQUIRED]: HttpStatus.BAD_REQUEST,

  // Lookup misses → 404.
  [CartErrorCodeEnum.CART_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [CartErrorCodeEnum.CART_LINE_NOT_FOUND]: HttpStatus.NOT_FOUND,

  // Ownership failure → 403: the caller is not the cart's owner (the retail-side
  // half of the owner-check, ADR-028 §7), or the claim ownership proof failed.
  [CartErrorCodeEnum.CART_ACCESS_FORBIDDEN]: HttpStatus.FORBIDDEN,

  // Conflicts with current state → 409: the cart is frozen (not active), an
  // illegal status transition was attempted, or the variant cannot be added in
  // its current pricing state (no applicable price).
  [CartErrorCodeEnum.CART_NOT_ACTIVE]: HttpStatus.CONFLICT,
  [CartErrorCodeEnum.CART_INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,
  [CartErrorCodeEnum.CART_VARIANT_NOT_PRICED]: HttpStatus.CONFLICT,
};

// Terminates a `CartDomainException` into the wire error shape the gateway's
// `throwRpcError` understands — `{ statusCode, message, code }`. Without this the
// raw domain exception reaches the gateway with no `statusCode`, so every cart
// rejection collapses to a 500 (the inventory/catalog filter rationale). Plain
// `Error`s (genuinely unexpected invariant breaches) are deliberately NOT caught
// here — they have no error code and stay 500.
@Catch(CartDomainException)
export class CartRpcExceptionFilter implements RpcExceptionFilter<CartDomainException> {
  public catch(exception: CartDomainException): Observable<never> {
    const statusCode = CART_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
    }));
  }
}
