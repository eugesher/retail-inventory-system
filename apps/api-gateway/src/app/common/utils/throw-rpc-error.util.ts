import {
  BadRequestException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

// REVIEW-FIX: QUAL-001 — added type guard before destructuring
export function throwRpcError(error: unknown): never {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const code = Number(record.statusCode) as HttpStatus;
    const msg = typeof record.message === 'string' ? record.message : undefined;

    if (code === HttpStatus.NOT_FOUND) throw new NotFoundException(msg);
    if (code === HttpStatus.BAD_REQUEST) throw new BadRequestException(msg);
  }

  throw new InternalServerErrorException();
}
