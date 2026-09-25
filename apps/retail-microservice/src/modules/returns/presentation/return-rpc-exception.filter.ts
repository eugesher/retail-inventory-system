import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { ReturnDomainException, ReturnErrorCodeEnum } from '../domain';

const RETURN_ERROR_STATUS: Record<ReturnErrorCodeEnum, HttpStatus> = {
  [ReturnErrorCodeEnum.RETURN_NO_LINES]: HttpStatus.BAD_REQUEST,
  [ReturnErrorCodeEnum.RETURN_LINE_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [ReturnErrorCodeEnum.RETURN_INSPECTION_INVALID]: HttpStatus.BAD_REQUEST,

  [ReturnErrorCodeEnum.RETURN_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ReturnErrorCodeEnum.RETURN_ORDER_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ReturnErrorCodeEnum.RETURN_ORDER_LINE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [ReturnErrorCodeEnum.RETURN_LINE_NOT_FOUND]: HttpStatus.NOT_FOUND,

  [ReturnErrorCodeEnum.RETURN_ACCESS_FORBIDDEN]: HttpStatus.FORBIDDEN,

  [ReturnErrorCodeEnum.RETURN_INVALID_STATUS_TRANSITION]: HttpStatus.CONFLICT,
  [ReturnErrorCodeEnum.RETURN_ORDER_NOT_RETURNABLE]: HttpStatus.CONFLICT,
  [ReturnErrorCodeEnum.RETURN_WINDOW_EXPIRED]: HttpStatus.CONFLICT,
  [ReturnErrorCodeEnum.RETURN_QUANTITY_EXCEEDS_RETURNABLE]: HttpStatus.CONFLICT,
  [ReturnErrorCodeEnum.RETURN_VERSION_MISMATCH]: HttpStatus.CONFLICT,
};

@Catch(ReturnDomainException)
export class ReturnRpcExceptionFilter implements RpcExceptionFilter<ReturnDomainException> {
  public catch(exception: ReturnDomainException): Observable<never> {
    const statusCode = RETURN_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
      ...(exception.details !== undefined ? { details: exception.details } : {}),
    }));
  }
}
