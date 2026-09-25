import { ArgumentsHost, Catch, ConflictException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';

const MYSQL_ER_DUP_ENTRY = 1062;

interface IMysqlDriverError {
  errno?: number;
  code?: string;
}

@Catch(QueryFailedError)
export class DuplicateKeyExceptionFilter extends BaseExceptionFilter {
  public catch(exception: QueryFailedError, host: ArgumentsHost): void {
    const driverError = (exception as QueryFailedError & { driverError?: IMysqlDriverError })
      .driverError;

    if (driverError?.errno === MYSQL_ER_DUP_ENTRY || driverError?.code === 'ER_DUP_ENTRY') {
      super.catch(new ConflictException('Resource already exists'), host);
      return;
    }

    super.catch(exception, host);
  }
}
