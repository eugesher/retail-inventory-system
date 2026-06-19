import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { ReturnDomainException, ReturnErrorCodeEnum } from '../domain';

// Maps each returns-context domain error code onto the HTTP status the gateway should
// surface. HTTP status is a transport concern, so the table lives here in the
// presentation layer — never in the transport-free domain (the orders/cart/inventory
// filter pattern, ADR-025 / ADR-027 / ADR-032). The mapping is a *total* `Record` keyed
// on the enum, so it is exhaustive at compile time: a new `ReturnErrorCodeEnum` member
// fails the build until it is given a status.
const RETURN_ERROR_STATUS: Record<ReturnErrorCodeEnum, HttpStatus> = {
  // Malformed-input / shape invariants → 400. Normally caught by the gateway request
  // DTOs first; this is the backstop for the directly-reachable RMQ path.
  [ReturnErrorCodeEnum.RETURN_NO_LINES]: HttpStatus.BAD_REQUEST,
  [ReturnErrorCodeEnum.RETURN_LINE_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID]: HttpStatus.BAD_REQUEST,

  // Lookup misses → 404.
  [ReturnErrorCodeEnum.RETURN_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ReturnErrorCodeEnum.RETURN_ORDER_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ReturnErrorCodeEnum.RETURN_ORDER_LINE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ReturnErrorCodeEnum.RETURN_LINE_NOT_FOUND]: HttpStatus.NOT_FOUND,

  // Ownership failure → 403: the caller is neither the RMA's owner (the order's buyer)
  // nor a staff override — the retail-side half of the owner-or-staff check (ADR-028 §7 /
  // ADR-032).
  [ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN]: HttpStatus.FORBIDDEN,

  // Conflicts with current state → 409: an illegal status transition, an order that
  // cannot be returned (neither delivered nor in-window shipped), a past-window order, or
  // an over-quantity request.
  [ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION]: HttpStatus.CONFLICT,
  [ReturnErrorCodeEnum.RETURN_ORDER_NOT_RETURNABLE]: HttpStatus.CONFLICT,
  [ReturnErrorCodeEnum.RETURN_WINDOW_EXPIRED]: HttpStatus.CONFLICT,
  [ReturnErrorCodeEnum.RETURN_QUANTITY_EXCEEDS_RETURNABLE]: HttpStatus.CONFLICT,
};

// Terminates a `ReturnDomainException` into the wire error shape the gateway's
// `throwRpcError` understands — `{ statusCode, message, code }`. Without this the raw
// domain exception reaches the gateway with no `statusCode`, so every return rejection
// collapses to a 500 (the orders/cart/inventory filter rationale). Plain `Error`s
// (genuinely unexpected invariant breaches) are deliberately NOT caught here — they have
// no error code and stay 500.
@Catch(ReturnDomainException)
export class ReturnRpcExceptionFilter implements RpcExceptionFilter<ReturnDomainException> {
  public catch(exception: ReturnDomainException): Observable<never> {
    const statusCode = RETURN_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
    }));
  }
}
