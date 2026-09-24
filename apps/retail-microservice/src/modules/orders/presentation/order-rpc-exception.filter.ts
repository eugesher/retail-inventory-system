import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { OrderDomainException, OrderErrorCodeEnum } from '../domain';

const ORDER_ERROR_STATUS: Record<OrderErrorCodeEnum, HttpStatus> = {
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
  [OrderErrorCodeEnum.FULFILLMENT_NO_LINES]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.FULFILLMENT_LINE_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.FULFILLMENT_TRACKING_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.REFUND_AMOUNT_INVALID]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.REFUND_REASON_REQUIRED]: HttpStatus.BAD_REQUEST,

  [OrderErrorCodeEnum.ORDER_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [OrderErrorCodeEnum.ORDER_CART_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [OrderErrorCodeEnum.FULFILLMENT_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [OrderErrorCodeEnum.ORDER_LINE_NOT_FOUND]: HttpStatus.NOT_FOUND,

  [OrderErrorCodeEnum.ORDER_CART_ACCESS_FORBIDDEN]: HttpStatus.FORBIDDEN,
  [OrderErrorCodeEnum.ORDER_ACCESS_FORBIDDEN]: HttpStatus.FORBIDDEN,
  [OrderErrorCodeEnum.REFUND_ACCESS_FORBIDDEN]: HttpStatus.FORBIDDEN,

  [OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.PAYMENT_INVALID_STATUS_TRANSITION]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_CART_NOT_PLACEABLE]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_CART_EMPTY]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_LINE_NO_PRICE]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_PAYMENT_NOT_APPROVED]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_PAYMENT_NOT_CAPTURED]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.PARTIAL_CAPTURE_UNSUPPORTED]: HttpStatus.UNPROCESSABLE_ENTITY,

  [OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REQUIRED]: HttpStatus.BAD_REQUEST,
  [OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_REUSED]: HttpStatus.UNPROCESSABLE_ENTITY,
  [OrderErrorCodeEnum.ORDER_IDEMPOTENCY_KEY_IN_PROGRESS]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.FULFILLMENT_INVALID_STATUS_TRANSITION]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_NOT_FULFILLABLE]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_INVALID_FULFILLMENT_TRANSITION]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_NOT_CANCELLABLE]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.ORDER_VERSION_MISMATCH]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.REFUND_INVALID_STATUS_TRANSITION]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.REFUND_EXCEEDS_REFUNDABLE]: HttpStatus.CONFLICT,
  [OrderErrorCodeEnum.REFUND_PAYMENT_NOT_CAPTURED]: HttpStatus.CONFLICT,
};

@Catch(OrderDomainException)
export class OrderRpcExceptionFilter implements RpcExceptionFilter<OrderDomainException> {
  public catch(exception: OrderDomainException): Observable<never> {
    const statusCode = ORDER_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
      ...(exception.details !== undefined ? { details: exception.details } : {}),
    }));
  }
}
