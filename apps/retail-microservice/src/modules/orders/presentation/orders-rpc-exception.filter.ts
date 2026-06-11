import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { OrderDomainException, OrderErrorCodeEnum } from '../domain';

// Maps each orders-context domain error code onto the HTTP status the gateway should
// surface. HTTP status is a transport concern, so the table lives here in the
// presentation layer — never in the transport-free domain (the cart/catalog/inventory
// filter pattern, ADR-025 / ADR-027). The mapping is a *total* `Record` keyed on the
// enum, so it is exhaustive at compile time: a new `OrderErrorCodeEnum` member fails
// the build until it is given a status.
const ORDER_ERROR_STATUS: Record<OrderErrorCodeEnum, HttpStatus> = {
  // Malformed-input invariants → 400. Normally caught by the gateway request DTOs
  // first; this is the backstop for the directly-reachable RMQ path.
  [OrderErrorCodeEnum.ORDER_CURRENCY_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_NO_LINES]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_MONEY_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_TOTAL_MISMATCH]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_VERSION_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_LINE_VARIANT_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_LINE_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_LINE_SKU_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_LINE_NAME_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_LINE_MONEY_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_LINE_TOTAL_MISMATCH]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ADDRESS_OWNER_TYPE_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ADDRESS_OWNER_ID_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ADDRESS_RECIPIENT_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ADDRESS_LINE1_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ADDRESS_CITY_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ADDRESS_REGION_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ADDRESS_POSTAL_CODE_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ADDRESS_COUNTRY_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.PAYMENT_ORDER_ID_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.PAYMENT_AMOUNT_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.PAYMENT_CURRENCY_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.PAYMENT_METHOD_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.PAYMENT_GATEWAY_REFERENCE_REQUIRED]: HttpStatus.BAD_REQUEST,

  // Lookup misses → 404.
  [OrderErrorCodeEnum.ORDER_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [OrderErrorCodeEnum.ORDER_CART_NOT_FOUND]: HttpStatus.NOT_FOUND,

  // Ownership failure → 403: the caller is not the cart's owner (place), nor the
  // order's owner / a staff override (read + capture) — the retail-side half of the
  // owner(-or-staff) check, ADR-028 §7.
  [OrderErrorCodeEnum.ORDER_CART_ACCESS_FORBIDDEN]: HttpStatus.FORBIDDEN,
  [OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN]: HttpStatus.FORBIDDEN,

  // Conflicts with current state → 409: an illegal payment-status transition, a cart
  // that cannot be placed (abandoned / empty), a line that cannot be priced, or a
  // declined authorize.
  [OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_CART_NOT_PLACEABLE]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_CART_EMPTY]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_LINE_NO_PRICE]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_PAYMENT_NOT_APPROVED]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_PAYMENT_NOT_CAPTURED]: HttpStatus.CONFLICT,
};

// Terminates an `OrderDomainException` into the wire error shape the gateway's
// `throwRpcError` understands — `{ statusCode, message, code }`. Without this the raw
// domain exception reaches the gateway with no `statusCode`, so every order rejection
// collapses to a 500 (the cart/inventory/catalog filter rationale). Plain `Error`s
// (genuinely unexpected invariant breaches) are deliberately NOT caught here — they
// have no error code and stay 500.
@Catch(OrderDomainException)
export class OrdersRpcExceptionFilter implements RpcExceptionFilter<OrderDomainException> {
  public catch(exception: OrderDomainException): Observable<never> {
    const statusCode = ORDER_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
    }));
  }
}
