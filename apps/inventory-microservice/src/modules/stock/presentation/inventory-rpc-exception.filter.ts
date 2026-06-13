import { Catch, HttpStatus, RpcExceptionFilter } from '@nestjs/common';
import { Observable, throwError } from 'rxjs';

import { InventoryDomainException, InventoryErrorCodeEnum } from '../domain';

// Maps each inventory domain error code onto the HTTP status the gateway should
// surface. HTTP status is a transport concern, so the table lives here in the
// presentation layer — never in the transport-free domain (ADR-027, mirroring the
// catalog/pricing filters — ADR-025 / ADR-026). The mapping is a *total* `Record`
// keyed on the enum, so it is exhaustive at compile time: a new
// `InventoryErrorCodeEnum` member fails the build until it is given a status.
const INVENTORY_ERROR_STATUS: Record<InventoryErrorCodeEnum, HttpStatus> = {
  // Malformed-input invariants → 400. Normally caught by the gateway request
  // DTOs first; this is the backstop for the directly-reachable RMQ path.
  [InventoryErrorCodeEnum.STOCK_RECEIVE_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [InventoryErrorCodeEnum.STOCK_ADJUSTMENT_DELTA_INVALID]: HttpStatus.BAD_REQUEST,
  [InventoryErrorCodeEnum.STOCK_ADJUSTMENT_REASON_REQUIRED]: HttpStatus.BAD_REQUEST,

  // Lookup miss → 404.
  [InventoryErrorCodeEnum.STOCK_LOCATION_NOT_FOUND]: HttpStatus.NOT_FOUND,

  // Conflicts with current state → 409: the request is well-formed but clashes
  // with what is persisted (the location is deactivated, or the adjustment would
  // drive on-hand below zero — the e2e asserts this 409 on `Adjust -100`), or the
  // optimistic write lost its retry budget to a concurrent writer.
  [InventoryErrorCodeEnum.STOCK_LOCATION_INACTIVE]: HttpStatus.CONFLICT,
  [InventoryErrorCodeEnum.STOCK_RESULT_NEGATIVE]: HttpStatus.CONFLICT,
  [InventoryErrorCodeEnum.STOCK_WRITE_CONFLICT]: HttpStatus.CONFLICT,

  // Reservation invariants (ADR-030). The aggregate enforces these now; the
  // Reserve / Release / Allocate use cases that surface them to a caller land in
  // later sessions, but the codes are mapped here so the total `Record` stays
  // exhaustive and the foundation compiles.
  [InventoryErrorCodeEnum.RESERVATION_QUANTITY_INVALID]: HttpStatus.BAD_REQUEST,
  [InventoryErrorCodeEnum.RESERVATION_INVALID_STATE]: HttpStatus.CONFLICT,
  [InventoryErrorCodeEnum.RESERVATION_EXPIRED]: HttpStatus.CONFLICT,
};

// Terminates an `InventoryDomainException` into the wire error shape the gateway's
// `throwRpcError` understands — `{ statusCode, message, code }`. Without this the
// raw domain exception reaches the gateway with no `statusCode`, so every
// inventory write failure collapses to a 500 (ADR-027). Plain `Error`s (genuinely
// unexpected invariant breaches) are deliberately NOT caught here — they have no
// error code and stay 500.
@Catch(InventoryDomainException)
export class InventoryRpcExceptionFilter implements RpcExceptionFilter<InventoryDomainException> {
  public catch(exception: InventoryDomainException): Observable<never> {
    const statusCode = INVENTORY_ERROR_STATUS[exception.code] ?? HttpStatus.INTERNAL_SERVER_ERROR;

    // The errored stream value is what the RMQ client receives as the rejection
    // payload (the same channel the catalog/pricing filters use).
    return throwError(() => ({
      statusCode,
      message: exception.message,
      code: exception.code,
    }));
  }
}
