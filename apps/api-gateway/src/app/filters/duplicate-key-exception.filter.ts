import { ArgumentsHost, Catch, ConflictException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { QueryFailedError } from 'typeorm';

// MySQL's "duplicate entry for key" error number. A unique-constraint violation
// that slips past an application-level check-then-act guard — the TOCTOU race
// where two concurrent inserts both pass `findByEmail() === null` and then one
// loses at the DB — surfaces as a QueryFailedError carrying this errno.
const MYSQL_ER_DUP_ENTRY = 1062;

interface IMysqlDriverError {
  errno?: number;
  code?: string;
}

// Maps a duplicate-key QueryFailedError to 409 Conflict so a lost
// check-then-act race returns the same status as the fast-path guard instead of
// a bare 500. Every other QueryFailedError is delegated untouched to the
// default handler (still a 500), keeping the blast radius to genuine duplicates.
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
