import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

import { CORRELATION_ID_HEADER } from './correlation.constants';

export const CorrelationId = createParamDecorator(
  (_, ctx: ExecutionContext): string =>
    ctx.switchToHttp().getRequest<Request>().headers[CORRELATION_ID_HEADER] as string,
);
