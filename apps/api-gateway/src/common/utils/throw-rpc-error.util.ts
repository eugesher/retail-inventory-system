import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

export function throwRpcError(error: unknown): never {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const code = Number(record.statusCode) as HttpStatus;
    const msg = typeof record.message === 'string' ? record.message : undefined;

    if (code === HttpStatus.NOT_FOUND) throw new NotFoundException(msg);
    if (code === HttpStatus.BAD_REQUEST) throw new BadRequestException(msg);
    if (code === HttpStatus.CONFLICT) throw new ConflictException(msg);
    // A retail-side owner-check rejection (defense-in-depth) arrives as a 403;
    // the gateway owner-check normally fires first, but map it so the backstop
    // never collapses into a 500.
    if (code === HttpStatus.FORBIDDEN) throw new ForbiddenException(msg);
  }

  throw new InternalServerErrorException();
}
