import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { InventoryDomainException, InventoryErrorCodeEnum } from '../domain';

const INVENTORY_ERROR_STATUS: Record<InventoryErrorCodeEnum, HttpStatus> = {
  [InventoryErrorCodeEnum.STOCK_RECEIVE_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [InventoryErrorCodeEnum.STOCK_ADJUSTMENT_DELTA_INVALID]: HttpStatus.BAD_REQUEST,
  [InventoryErrorCodeEnum.STOCK_ADJUSTMENT_REASON_REQUIRED]: HttpStatus.BAD_REQUEST,
  [InventoryErrorCodeEnum.TRANSFER_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [InventoryErrorCodeEnum.TRANSFER_SAME_LOCATION]: HttpStatus.BAD_REQUEST,

  [InventoryErrorCodeEnum.STOCK_LOCATION_NOT_FOUND]: HttpStatus.NOT_FOUND,

  [InventoryErrorCodeEnum.STOCK_LOCATION_INACTIVE]: HttpStatus.CONFLICT,
  [InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE]: HttpStatus.CONFLICT,
  [InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT]: HttpStatus.CONFLICT,

  [InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [InventoryErrorCodeEnum.RESERVATION_INVALID_STATE]: HttpStatus.CONFLICT,
  [InventoryErrorCodeEnum.RESERVATION_EXPIRED]: HttpStatus.CONFLICT,
  [InventoryErrorCodeEnum.RESERVATION_SELECTOR_INVALID]: HttpStatus.BAD_REQUEST,
  [InventoryErrorCodeEnum.RESERVATION_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [InventoryErrorCodeEnum.OUT_OF_STOCK]: HttpStatus.CONFLICT,
};

@Catch(InventoryDomainException)
export class InventoryRpcExceptionFilter implements RpcExceptionFilter<InventoryDomainException> {
  public catch(exception: InventoryDomainException): Observable<never> {
    const statusCode = INVENTORY_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
      ...(exception.details !== undefined ? { details: exception.details } : {}),
    }));
  }
}
