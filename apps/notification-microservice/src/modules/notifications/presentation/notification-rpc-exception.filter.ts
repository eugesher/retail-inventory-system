import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { NotificationDomainException, NotificationErrorCodeEnum } from '../domain';

// Maps each notification domain error code onto the HTTP status the gateway should
// surface. HTTP status is a transport concern, so the table lives here in the
// presentation layer — never in the transport-free domain (the
// `CatalogRpcExceptionFilter` / `OrdersRpcExceptionFilter` precedent, ADR-025). The
// mapping is a *total* `Record` keyed on the enum, so it is exhaustive at compile
// time: a new `NotificationErrorCodeEnum` member fails the build until it is given a
// status. Every code is mapped now even though the template authoring operations
// throw only a subset — the delivery codes are reached by later capabilities.
const NOTIFICATION_ERROR_STATUS: Record<NotificationErrorCodeEnum, HttpStatus> = {
  // Malformed input invariants → 400. Normally caught by the gateway request DTOs
  // first; this is the backstop for the directly-reachable RMQ path.
  [NotificationErrorCodeEnum.TEMPLATE_BODY_REQUIRED]: HttpStatus.BAD_REQUEST,
  [NotificationErrorCodeEnum.TEMPLATE_SUBJECT_REQUIRED]: HttpStatus.BAD_REQUEST,
  [NotificationErrorCodeEnum.TEMPLATE_EVENT_TYPE_REQUIRED]: HttpStatus.BAD_REQUEST,
  [NotificationErrorCodeEnum.TEMPLATE_LOCALE_REQUIRED]: HttpStatus.BAD_REQUEST,
  [NotificationErrorCodeEnum.TEMPLATE_VERSION_INVALID]: HttpStatus.BAD_REQUEST,
  [NotificationErrorCodeEnum.DELIVERY_RECIPIENT_REQUIRED]: HttpStatus.BAD_REQUEST,

  // Read/lookup misses → 404.
  [NotificationErrorCodeEnum.TEMPLATE_NOT_FOUND]: HttpStatus.NOT_FOUND,
  [NotificationErrorCodeEnum.DELIVERY_NOT_FOUND]: HttpStatus.NOT_FOUND,

  // Lifecycle / uniqueness conflicts → 409: the request is well-formed but conflicts
  // with the current state of the resource (a version already exists, or a delivery
  // status transition is illegal from the current state).
  [NotificationErrorCodeEnum.TEMPLATE_DUPLICATE_VERSION]: HttpStatus.CONFLICT,
  [NotificationErrorCodeEnum.DELIVERY_INVALID_STATUS_TRANSITION]: HttpStatus.CONFLICT,
};

// Terminates a `NotificationDomainException` into the wire error shape the gateway's
// `throwRpcError` understands — `{ statusCode, message, code }`. Without this the raw
// domain exception reaches the gateway with no `statusCode`, so every notification
// failure collapses to a 500 (ADR-025). Plain `Error`s (internal invariant breaches
// such as "persisted template id missing after save") are deliberately NOT caught
// here: they have no error code, are genuinely unexpected, and stay 500.
@Catch(NotificationDomainException)
export class NotificationRpcExceptionFilter implements RpcExceptionFilter<NotificationDomainException> {
  public catch(exception: NotificationDomainException): Observable<never> {
    const statusCode =
      NOTIFICATION_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    // The errored stream value is what the RMQ client receives as the rejection
    // payload (the same channel the catalog/order filters use).
    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
    }));
  }
}
