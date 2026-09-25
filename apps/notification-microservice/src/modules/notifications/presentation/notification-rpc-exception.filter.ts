import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { NotificationDomainException, NotificationErrorCodeEnum } from '../domain';

const NOTIFICATION_ERROR_STATUS: Record<NotificationErrorCodeEnum, HttpStatus> = {
  [NotificationErrorCodeEnum.TEMPLATE_BODY_REQUIRED]: HttpStatus.BAD_REQUEST,
  [NotificationErrorCodeEnum.TEMPLATE_SUBJECT_REQUIRED]: HttpStatus.BAD_REQUEST,
  [NotificationErrorCodeEnum.TEMPLATE_EVENT_TYPE_REQUIRED]: HttpStatus.BAD_REQUEST,
  [NotificationErrorCodeEnum.TEMPLATE_LOCALE_REQUIRED]: HttpStatus.BAD_REQUEST,
  [NotificationErrorCodeEnum.TEMPLATE_VERSION_INVALID]: HttpStatus.BAD_REQUEST,
  [NotificationErrorCodeEnum.DELIVERY_RECIPIENT_REQUIRED]: HttpStatus.BAD_REQUEST,

  [NotificationErrorCodeEnum.TEMPLATE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [NotificationErrorCodeEnum.DELIVERY_NOT_FOUND]: HttpStatus.NOT_FOUND,

  [NotificationErrorCodeEnum.TEMPLATE_DUPLICATE_VERSION]: HttpStatus.CONFLICT,
  [NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION]: HttpStatus.CONFLICT,
};

@Catch(NotificationDomainException)
export class NotificationRpcExceptionFilter implements RpcExceptionFilter<NotificationDomainException> {
  public catch(exception: NotificationDomainException): Observable<never> {
    const statusCode =
      NOTIFICATION_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
    }));
  }
}
