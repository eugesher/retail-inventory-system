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
  // illegal status transition was attempted, the variant cannot be added in its
  // current pricing state (no applicable price), or an optimistic-concurrency
  // write lost its bounded retry budget to a concurrent writer / a stale
  // `If-Match` (ADR-036 — the wire code is the uniform `VERSION_MISMATCH`, and the
  // exception carries `details.currentVersion`).
  [CartErrorCodeEnum.CART_NOT_ACTIVE]: HttpStatus.CONFLICT,
  [CartErrorCodeEnum.CART_INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,
  [CartErrorCodeEnum.CART_VARIANT_NOT_PRICED]: HttpStatus.CONFLICT,
  [CartErrorCodeEnum.CART_VERSION_MISMATCH]: HttpStatus.CONFLICT,
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

    // `details` rides along only when present (e.g. `{ currentVersion }` on a
    // `VERSION_MISMATCH`, ADR-036) — the gateway's `throwRpcError` forwards an
    // object-valued `details` verbatim and harmlessly drops an absent one, so a
    // client reads `details.currentVersion` end-to-end (the inventory
    // `{ available }` forwarding, ADR-030 §6).
    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
      ...(exception.details !== undefined ? { details: exception.details } : {}),
    }));
  }
}
