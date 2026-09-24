import { NextFunction, Request, Response } from 'express';

import { CORRELATION_ID_HEADER } from '../correlation/correlation.constants';
import { CorrelationMiddleware } from '../correlation/http-context.middleware';

describe('CorrelationMiddleware', () => {
  const middleware = new CorrelationMiddleware();

  const buildReq = (header?: string): Request =>
    ({ headers: header ? { [CORRELATION_ID_HEADER]: header } : {} }) as unknown as Request;

  const buildRes = (): { res: Response; setHeader: jest.Mock } => {
    const setHeader = jest.fn();
    const res = { setHeader } as unknown as Response;
    return { res, setHeader };
  };

  it('preserves an inbound correlation ID', () => {
    const req = buildReq('abc-123');
    const { res, setHeader } = buildRes();
    const next = jest.fn() as NextFunction;

    middleware.use(req, res, next);

    expect(req.headers[CORRELATION_ID_HEADER]).toBe('abc-123');
    expect(setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, 'abc-123');
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('generates a UUID when no inbound header is present', () => {
    const req = buildReq();
    const { res, setHeader } = buildRes();
    const next = jest.fn() as NextFunction;

    middleware.use(req, res, next);

    const generated = req.headers[CORRELATION_ID_HEADER];
    expect(typeof generated).toBe('string');
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
    expect(setHeader).toHaveBeenCalledWith(CORRELATION_ID_HEADER, generated);
  });
});
