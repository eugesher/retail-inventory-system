import {
  BadRequestException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

export function throwRpcError(error: unknown): never {
  const { statusCode, message } = error as Record<string, unknown>;
  const code = Number(statusCode) as HttpStatus;
  const msg = typeof message === 'string' ? message : undefined;

  if (code === HttpStatus.NOT_FOUND) throw new NotFoundException(msg);
  if (code === HttpStatus.BAD_REQUEST) throw new BadRequestException(msg);

  throw new InternalServerErrorException(msg);
}
