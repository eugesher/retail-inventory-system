import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { CartDomainException, CartErrorCodeEnum } from '../domain';

const CART_ERROR_STATUS: Record<CartErrorCodeEnum, HttpStatus> = {
  [CartErrorCodeEnum.CART_CURRENCY_INVALID]: HttpStatus.BAD_REQUEST,
  [CartErrorCodeEnum.CART_VERSION_INVALID]: HttpStatus.BAD_REQUEST,
  [CartErrorCodeEnum.CART_LINE_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [CartErrorCodeEnum.CART_LINE_VARIANT_INVALID]: HttpStatus.BAD_REQUEST,
  [CartErrorCodeEnum.CART_LINE_PRICE_INVALID]: HttpStatus.BAD_REQUEST,
  [CartErrorCodeEnum.CART_LINE_CURRENCY_REQUIRED]: HttpStatus.BAD_REQUEST,

  [CartErrorCodeEnum.CART_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [CartErrorCodeEnum.CART_LINE_NOT_FOUND]: HttpStatus.NOT_FOUND,

  [CartErrorCodeEnum.CART_ACCESS_FORBIDDEN]: HttpStatus.FORBIDDEN,

  [CartErrorCodeEnum.CART_NOT_ACTIVE]: HttpStatus.CONFLICT,
  [CartErrorCodeEnum.CART_INVALID_STATE_TRANSITION]: HttpStatus.CONFLICT,
  [CartErrorCodeEnum.CART_VARIANT_NOT_PRICED]: HttpStatus.CONFLICT,
  [CartErrorCodeEnum.CART_VERSION_MISMATCH]: HttpStatus.CONFLICT,
};

@Catch(CartDomainException)
export class CartRpcExceptionFilter implements RpcExceptionFilter<CartDomainException> {
  public catch(exception: CartDomainException): Observable<never> {
    const statusCode = CART_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
      ...(exception.details !== undefined ? { details: exception.details } : {}),
    }));
  }
}
