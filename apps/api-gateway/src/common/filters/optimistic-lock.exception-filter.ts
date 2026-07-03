import { ArgumentsHost, Catch, ConflictException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { OptimisticLockVersionMismatchError } from 'typeorm';

// The uniform cross-service wire code for an optimistic-concurrency conflict
// (ADR-036). It is the same string the microservice RPC filters emit for their
// aggregate OCC exhaustion (`VERSION_MISMATCH`), so a client branches on one code
// regardless of whether the conflict came from a downstream service or a
// gateway-local TypeORM write.
export const VERSION_MISMATCH_CODE = 'VERSION_MISMATCH';

// TypeORM bakes the versions into the error message rather than exposing them as
// fields: `The optimistic lock on entity X failed, version 3 was expected, but is
// actually 5.` Recover the *actual* (current) version so the response can carry
// `currentVersion` for a refetch-and-retry, mirroring what the RPC filters ship in
// `details.currentVersion`.
const ACTUAL_VERSION_PATTERN = /is actually (\d+)/;

// Maps TypeORM's `OptimisticLockVersionMismatchError` to a `409` carrying the
// uniform `{ code: VERSION_MISMATCH, currentVersion }` contract, so a lost
// gateway-local compare-and-swap never leaks a raw `500` and reads the same as a
// downstream aggregate conflict (ADR-036 §3). The gateway's own TypeORM writes
// (the `auth` aggregates) carry no version columns today, so in practice this is
// defense-in-depth + the normalized contract + the documented convention — but it
// makes the gateway honor `VERSION_MISMATCH` uniformly the moment any gateway
// aggregate adopts optimistic locking.
//
// It extends `BaseExceptionFilter` and delegates the actual rendering to
// `super.catch` (the `DuplicateKeyExceptionFilter` precedent), so the response
// goes through Nest's HTTP machinery. A non-matching exception (defensive — Nest
// only routes the `@Catch`ed type here) is passed through untouched.
@Catch(OptimisticLockVersionMismatchError)
export class OptimisticLockExceptionFilter extends BaseExceptionFilter {
  public catch(exception: unknown, host: ArgumentsHost): void {
    if (!(exception instanceof OptimisticLockVersionMismatchError)) {
      super.catch(exception, host);
      return;
    }

    const match = ACTUAL_VERSION_PATTERN.exec(exception.message);
    const currentVersion = match ? Number(match[1]) : undefined;

    super.catch(
      new ConflictException({
        statusCode: HttpStatus.CONFLICT,
        message: exception.message,
        code: VERSION_MISMATCH_CODE,
        ...(currentVersion !== undefined ? { currentVersion } : {}),
      }),
      host,
    );
  }
}
