import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';

// The wire error `code` for a missing required `Idempotency-Key`. It is the gateway
// edge equivalent of the retail-side `ORDER_IDEMPOTENCY_KEY_REQUIRED` backstop; a
// client branches on this stable code rather than string-matching the message
// (docs/adr/036-idempotency-key-store-and-enforced-occ.md).
export const IDEMPOTENCY_KEY_REQUIRED_CODE = 'IDEMPOTENCY_KEY_REQUIRED';

// A required-header parameter decorator for `Idempotency-Key` (ADR-036). The header is
// an HTTP concern, so it is validated at the edge — fail fast with a `400` before any
// RPC is dispatched — rather than deferred to the retail domain. It reads the header
// (case-insensitive, per HTTP), trims it, and rejects an absent/blank value with a
// `400 { statusCode, message, code: IDEMPOTENCY_KEY_REQUIRED }` body — the same
// `{ statusCode, message, code }` shape the RPC errors carry, so a client handles both
// uniformly. Reusable across every idempotent write route (place order today; capture /
// ship / refund follow the same pattern), which is why it lives in the gateway's shared
// `common/` rather than a single module.
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const raw = request.headers['idempotency-key'];
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (key.length === 0) {
      throw new BadRequestException({
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'The Idempotency-Key header is required for this operation.',
        code: IDEMPOTENCY_KEY_REQUIRED_CODE,
      });
    }
    return key;
  },
);
