import { ArgumentsHost, Catch, ConflictException, HttpStatus } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { OptimisticLockVersionMismatchError } from 'typeorm';

export const VERSION_MISMATCH_CODE = 'VERSION_MISMATCH';

const ACTUAL_VERSION_PATTERN = /is actually (\d+)/;

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
