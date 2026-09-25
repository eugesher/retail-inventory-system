import {
  BadRequestException,
  createParamDecorator,
  ExecutionContext,
  HttpStatus,
} from '@nestjs/common';
import { Request } from 'express';

export const IF_MATCH_INVALID_CODE = 'IF_MATCH_INVALID';

export const IfMatch = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): number | undefined => {
    const request = ctx.switchToHttp().getRequest<Request>();
    const raw = request.headers['if-match'];
    if (typeof raw !== 'string') {
      return undefined;
    }

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
