import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

export function throwRpcError(error: unknown): never {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    const statusCode = Number(record.statusCode) as HttpStatus;
    const message = typeof record.message === 'string' ? record.message : undefined;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const details =
      typeof record.details === 'object' && record.details !== null
        ? (record.details as Record<string, unknown>)
        : undefined;

    const payload =
      code !== undefined
        ? details !== undefined
          ? { statusCode, message, code, details }
          : { statusCode, message, code }
        : message;

    if (statusCode === HttpStatus.NOT_FOUND) throw new NotFoundException(payload);
    if (statusCode === HttpStatus.BAD_REQUEST) throw new BadRequestException(payload);
    if (statusCode === HttpStatus.CONFLICT) throw new ConflictException(payload);
    if (statusCode === HttpStatus.FORBIDDEN) throw new ForbiddenException(payload);

    const numericStatus = Number(statusCode);
    if (
      code !== undefined &&
      Number.isInteger(numericStatus) &&
      numericStatus >= 400 &&
      numericStatus <= 599
    ) {
      throw new HttpException(
        details !== undefined
          ? { statusCode, message, code, details }
          : { statusCode, message, code },
        statusCode,
      );
    }
  }

  throw new InternalServerErrorException();
}
