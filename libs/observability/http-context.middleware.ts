import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Request, Response, NextFunction } from 'express';

import { CORRELATION_ID_HEADER } from './correlation.constants';

// HTTP entry middleware: ensures every inbound request carries a stable
// correlation ID for cross-service log correlation. ADR-001's contract still
// holds — header value preserved verbatim from the libs/common move.
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  public use(req: Request, res: Response, next: NextFunction): void {
    const correlationId = (req.headers[CORRELATION_ID_HEADER] as string) || randomUUID();

    req.headers[CORRELATION_ID_HEADER] = correlationId;
    res.setHeader(CORRELATION_ID_HEADER, correlationId);

    next();
  }
}
