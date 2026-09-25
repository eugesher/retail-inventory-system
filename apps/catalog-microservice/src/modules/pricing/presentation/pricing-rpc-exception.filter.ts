import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { PricingDomainException, PricingErrorCodeEnum } from '../domain';

const PRICING_ERROR_STATUS: Record<PricingErrorCodeEnum, HttpStatus> = {
  [PricingErrorCodeEnum.PRICE_AMOUNT_INVALID]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.PRICE_CURRENCY_INVALID]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.PRICE_INTERVAL_INVALID]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.PRICE_VALID_FROM_IN_PAST]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.PRICE_PRIORITY_INVALID]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.TAX_CATEGORY_CODE_INVALID]: HttpStatus.BAD_REQUEST,
  [PricingErrorCodeEnum.TAX_CATEGORY_NAME_REQUIRED]: HttpStatus.BAD_REQUEST,

  [PricingErrorCodeEnum.PRICE_SCHEDULE_CONFLICT]: HttpStatus.CONFLICT,
  [PricingErrorCodeEnum.TAX_CATEGORY_CODE_TAKEN]: HttpStatus.CONFLICT,

  [PricingErrorCodeEnum.TAX_CATEGORY_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [PricingErrorCodeEnum.VARIANT_NOT_FOUND]: HttpStatus.NOT_FOUND,
};

@Catch(PricingDomainException)
export class PricingRpcExceptionFilter implements RpcExceptionFilter<PricingDomainException> {
  public catch(exception: PricingDomainException): Observable<never> {
    const statusCode = PRICING_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
    }));
  }
}
