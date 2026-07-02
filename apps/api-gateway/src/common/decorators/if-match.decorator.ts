import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';

// The wire error `code` for a malformed `If-Match` header. A client that sends the
// precondition at all must send a well-formed non-negative integer version; a
// garbage value is a client bug surfaced rather than silently ignored (silently
// dropping a precondition would defeat its purpose — the write would proceed
// unguarded). It branches on this stable code, not the human message
// (docs/adr/036-idempotency-key-store-and-enforced-occ.md).
export const IF_MATCH_INVALID_CODE = 'IF_MATCH_INVALID';

// An OPTIONAL precondition parameter decorator for `If-Match` (ADR-036). The
// header is an HTTP concern, so it is parsed at the edge and threaded into the
// command as `expectedVersion`. Unlike `@IdempotencyKey()` (required), `If-Match`
// is optional: an absent header returns `undefined` and the write falls back to
// the bounded optimistic-retry path. When present, the header carries the cart's
// optimistic-concurrency `version` (the integer surfaced on `CartView.version`);
// surrounding double-quotes are tolerated (some clients quote ETags). A present
// but non-integer / negative value fails fast with a
// `400 { statusCode, message, code: IF_MATCH_INVALID }` — the same
// `{ statusCode, message, code }` shape the RPC errors carry. Reusable across
// every OCC-guarded write route (the cart line routes today; order / fulfillment /
// return follow), which is why it lives in the gateway's shared `common/`.
export const IfMatch = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const raw = request.headers['if-match'];
    if (typeof raw !== 'string') {
      return undefined;
    }

    // Tolerate an ETag-style quoted value (`If-Match: "3"`) and stray whitespace.
    const trimmed = raw.trim().replace(/^"(.*)"$/, '$1');
    if (trimmed.length === 0) {
      return undefined;
    }

    const version = Number(trimmed);
    if (!Number.isInteger(version) || version < 0) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'The If-Match header must be a non-negative integer version.',
        code: IF_MATCH_INVALID_CODE,
      });
    }
    return version;
  },
);
