import { DomainException } from '@retail-inventory-system/common';

export enum ReturnErrorCodeEnum {
  RETURN_NO_LINES = 'RETURN_NO_LINES',
  RETURN_LINE_QUANTITY_INVALID = 'RETURN_LINE_QUANTITY_INVALID',
  RETURN_INVALID_STATUS_TRANSITION = 'RETURN_INVALID_STATUS_TRANSITION',
  RETURN_INSPECTION_INVALID = 'RETURN_INSPECTION_INVALID',
  RETURN_VERSION_MISMATCH = 'VERSION_MISMATCH',

  RETURN_NOT_FOUND = 'RETURN_NOT_FOUND',
  RETURN_ACCESS_FORBIDDEN = 'RETURN_ACCESS_FORBIDDEN',
  RETURN_ORDER_NOT_FOUND = 'RETURN_ORDER_NOT_FOUND',
  RETURN_ORDER_NOT_RETURNABLE = 'RETURN_ORDER_NOT_RETURNABLE',
  RETURN_WINDOW_EXPIRED = 'RETURN_WINDOW_EXPIRED',
  RETURN_QUANTITY_EXCEEDS_RETURNABLE = 'RETURN_QUANTITY_EXCEEDS_RETURNABLE',
  RETURN_ORDER_LINE_NOT_FOUND = 'RETURN_ORDER_LINE_NOT_FOUND',
  RETURN_LINE_NOT_FOUND = 'RETURN_LINE_NOT_FOUND',
}

export class ReturnDomainException extends DomainException {
  public readonly code: ReturnErrorCodeEnum;
  public readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: ReturnErrorCodeEnum,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
