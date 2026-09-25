import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { throwRpcError } from '../utils/throw-rpc-error.util';

const rpcRejection = (
  statusCode: number,
  code: string | undefined,
  extras: Record<string, unknown> = {},
): unknown => ({
  statusCode,
  message: 'upstream refused',
  ...(code !== undefined ? { code } : {}),
  ...extras,
});

const captureThrown = (error: unknown): unknown => {
  try {
    throwRpcError(error);
  } catch (thrown) {
    return thrown;
  }
  throw new Error('throwRpcError returned instead of throwing');
};

const bodyOf = (thrown: unknown): unknown => (thrown as HttpException).getResponse();
const statusOf = (thrown: unknown): number => (thrown as HttpException).getStatus();

describe('throwRpcError — the four explicitly mapped statuses', () => {
  it.each([
    [404, NotFoundException, 'CATALOG_VARIANT_NOT_FOUND'],
    [400, BadRequestException, 'CATALOG_SLUG_INVALID'],
    [409, ConflictException, 'INVENTORY_OUT_OF_STOCK'],
    [403, ForbiddenException, 'ORDER_ACCESS_FORBIDDEN'],
  ] as const)('maps %i to the matching Nest exception, code intact', (status, type, code) => {
    const thrown = captureThrown(rpcRejection(status, code));

    expect(thrown).toBeInstanceOf(type);
    expect(statusOf(thrown)).toBe(status);
    expect(bodyOf(thrown)).toEqual({ statusCode: status, message: 'upstream refused', code });
  });

  it('does not let the 403 backstop collapse into a 500', () => {
    const thrown = captureThrown(rpcRejection(403, 'ORDER_ACCESS_FORBIDDEN'));

    expect(thrown).not.toBeInstanceOf(InternalServerErrorException);
    expect(statusOf(thrown)).toBe(403);
  });
});

describe('throwRpcError — the statuses that exist only through the generic branch', () => {
  it('forwards a 422 with its code rather than collapsing it to a 500', () => {
    const thrown = captureThrown(rpcRejection(422, 'PARTIAL_CAPTURE_UNSUPPORTED'));

    expect(thrown).toBeInstanceOf(HttpException);
    expect(statusOf(thrown)).toBe(422);
    expect(bodyOf(thrown)).toEqual({
      statusCode: 422,
      message: 'upstream refused',
      code: 'PARTIAL_CAPTURE_UNSUPPORTED',
    });
  });

  it('keeps the body of a code-bearing upstream 500 instead of emptying it', () => {
    const thrown = captureThrown(rpcRejection(500, 'ORDER_REFUND_GATEWAY_FAILED'));

    expect(statusOf(thrown)).toBe(500);
    expect(bodyOf(thrown)).toEqual({
      statusCode: 500,
      message: 'upstream refused',
      code: 'ORDER_REFUND_GATEWAY_FAILED',
    });
  });

  it('forwards any other in-range status that carried a code (401, 429)', () => {
    expect(statusOf(captureThrown(rpcRejection(401, 'AUTH_TOKEN_EXPIRED')))).toBe(401);
    expect(statusOf(captureThrown(rpcRejection(429, 'RATE_LIMITED')))).toBe(429);
  });

  it('refuses to forward a status outside the error range, even with a code', () => {
    expect(captureThrown(rpcRejection(200, 'SOMEHOW_OK'))).toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(captureThrown(rpcRejection(302, 'SOMEHOW_REDIRECT'))).toBeInstanceOf(
      InternalServerErrorException,
    );
  });
});

describe('throwRpcError — the details payload', () => {
  it('forwards a structured details object alongside the code', () => {
    const thrown = captureThrown(
      rpcRejection(409, 'INVENTORY_OUT_OF_STOCK', { details: { available: 3 } }),
    );

    expect(bodyOf(thrown)).toEqual({
      statusCode: 409,
      message: 'upstream refused',
      code: 'INVENTORY_OUT_OF_STOCK',
      details: { available: 3 },
    });
  });

  it('forwards details through the generic branch too, not only the four mapped ones', () => {
    const thrown = captureThrown(
      rpcRejection(422, 'PARTIAL_CAPTURE_UNSUPPORTED', {
        details: { grandTotalMinor: 29997 },
      }),
    );

    expect(bodyOf(thrown)).toEqual({
      statusCode: 422,
      message: 'upstream refused',
      code: 'PARTIAL_CAPTURE_UNSUPPORTED',
      details: { grandTotalMinor: 29997 },
    });
  });

  it.each([
    ['a string', 'only 3 left'],
    ['null', null],
    ['a number', 3],
  ])('drops details that is %s, keeping the body shape stable', (_label, details) => {
    const body = bodyOf(captureThrown(rpcRejection(409, 'INVENTORY_OUT_OF_STOCK', { details })));

    expect(body).not.toHaveProperty('details');
  });

  it('omits the details key entirely when the upstream carried none', () => {
    const body = bodyOf(captureThrown(rpcRejection(409, 'INVENTORY_OUT_OF_STOCK')));

    expect(body).not.toHaveProperty('details');
  });
});

describe('throwRpcError — rejections with nothing to forward', () => {
  it('preserves Nest’s default body shape when there is no typed code', () => {
    const thrown = captureThrown(rpcRejection(404, undefined));

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(bodyOf(thrown)).toEqual({
      statusCode: 404,
      message: 'upstream refused',
      error: 'Not Found',
    });
  });

  it('collapses a code-less 422 to a 500 — the generic branch is gated on the code', () => {
    expect(captureThrown(rpcRejection(422, undefined))).toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  it('answers a bare 500 for a rejection with no statusCode (NaN)', () => {
    const thrown = captureThrown({ message: 'no response from retail_queue' });

    expect(thrown).toBeInstanceOf(InternalServerErrorException);
    expect(statusOf(thrown)).toBe(500);
  });

  it.each([
    ['a plain Error', new Error('ECONNRESET')],
    ['a string', 'boom'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
  ])('answers a bare 500 for %s', (_label, error) => {
    expect(captureThrown(error)).toBeInstanceOf(InternalServerErrorException);
  });

  it('drops a non-string message rather than forwarding an array', () => {
    const thrown = captureThrown({
      statusCode: 400,
      message: ['name must be a string'],
      code: 'CATALOG_SLUG_INVALID',
    });

    expect(bodyOf(thrown)).toEqual({
      statusCode: 400,
      message: undefined,
      code: 'CATALOG_SLUG_INVALID',
    });
  });
});
