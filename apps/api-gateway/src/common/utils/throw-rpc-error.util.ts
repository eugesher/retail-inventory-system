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

    // Forward the upstream typed error code (e.g. CATALOG_CATEGORY_CYCLE,
    // CATALOG_MEDIA_REORDER_SET_MISMATCH) into the HTTP error body so a client
    // can branch on a stable, greppable code instead of brittle-matching the
    // human-readable message. Every microservice RPC filter already emits
    // `{ statusCode, message, code }`; the gateway used to drop the code at this
    // boundary. With a code present the body becomes `{ statusCode, message,
    // code }`; without one the standard Nest `{ statusCode, message, error }`
    // shape is preserved (a non-RPC error carries no code to forward).
    const payload = code !== undefined ? { statusCode, message, code } : message;

    if (statusCode === HttpStatus.NOT_FOUND) throw new NotFoundException(payload);
    if (statusCode === HttpStatus.BAD_REQUEST) throw new BadRequestException(payload);
    if (statusCode === HttpStatus.CONFLICT) throw new ConflictException(payload);
    // A retail-side owner-check rejection (defense-in-depth) arrives as a 403;
    // the gateway owner-check normally fires first, but map it so the backstop
    // never collapses into a 500.
    if (statusCode === HttpStatus.FORBIDDEN) throw new ForbiddenException(payload);

    // Any OTHER upstream HTTP error status that still carried a typed code (a
    // future 401/422/429 mapping, or an upstream 500 that nonetheless tagged a
    // code) — forward the status AND the code rather than letting the `payload`
    // just built collapse into a bodyless 500, which would silently defeat the
    // code-forwarding above. A non-RPC error (no `code`, or a NaN `statusCode`
    // from a transport-level rejection) still falls through to the bare 500.
    const numericStatus = Number(statusCode);
    if (
      code !== undefined &&
      Number.isInteger(numericStatus) &&
      numericStatus >= 400 &&
      numericStatus <= 599
    ) {
      throw new HttpException({ statusCode, message, code }, statusCode);
    }
  }

  throw new InternalServerErrorException();
}
