import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

import { throwRpcError } from '../utils/throw-rpc-error.util';

// **The gateway's only error-translation boundary, and it had no spec.**
//
// Every RPC-fronting use case in the gateway ends the same way: `catch { logger.error(...);
// throwRpcError(error) }`. This function is the single place where a microservice's rejection —
// `{ statusCode, message, code }` (+ optional `details`), the shape every `*RpcExceptionFilter` puts on
// the wire — becomes the HTTP error a client actually sees.
//
// **Its failure mode is not an exception; it is a downgrade.** Drop the `code` and every client's
// error handling falls back to matching human-readable prose. Drop the status and a 409 becomes a 500,
// telling the caller to retry something that will never succeed. Neither shows up in a happy-path test,
// and neither throws.
//
// The status set is not hypothetical. Across the five `*RpcExceptionFilter`s the wire carries: 400
// (×73), 409 (×47), 404 (×23), 500 (×7), 403 (×5) and **422 (×2)**. Only the first four have an
// explicit branch here — **422 and code-bearing 500s reach the client only through the generic branch
// at the bottom**, which is therefore not a defensive afterthought but the sole path for two real
// statuses.

// The wire shape, exactly as a `*RpcExceptionFilter` emits it. Not an `Error` — a plain object thrown
// through `throwError(() => ({...}))`, which is why the function duck-types instead of using
// `instanceof`.
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

// `throwRpcError` returns `never`, so every assertion goes through the thrown value.
const captureThrown = (error: unknown): unknown => {
  try {
    throwRpcError(error);
  } catch (thrown) {
    return thrown;
  }
  // Unreachable: the function's return type is `never`. If it ever falls through, the tests must say
  // so loudly rather than silently assert on `undefined`.
  throw new Error('throwRpcError returned instead of throwing');
};

const bodyOf = (thrown: unknown): unknown => (thrown as HttpException).getResponse();
const statusOf = (thrown: unknown): number => (thrown as HttpException).getStatus();

describe('throwRpcError — the four explicitly mapped statuses', () => {
  // Each of these carries a typed code, so the body becomes `{ statusCode, message, code }` rather than
  // Nest's default `{ statusCode, message, error }`. That substitution is the whole feature: a client
  // branches on `CATALOG_CATEGORY_CYCLE`, not on the sentence.
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

  // 403 is the retail-side owner check firing as a backstop — the gateway's own owner check normally
  // rejects first (ADR-051). Without this branch the defense-in-depth layer would surface as a 500, i.e.
  // "we are broken" rather than "you may not".
  it('does not let the 403 backstop collapse into a 500', () => {
    const thrown = captureThrown(rpcRejection(403, 'ORDER_ACCESS_FORBIDDEN'));

    expect(thrown).not.toBeInstanceOf(InternalServerErrorException);
    expect(statusOf(thrown)).toBe(403);
  });
});

describe('throwRpcError — the statuses that exist only through the generic branch', () => {
  // **422 has no explicit branch, and 422 is real**: `PARTIAL_CAPTURE_UNSUPPORTED` (ISSUE-09) and one
  // other. Delete the generic branch below the four `if`s — it reads like belt-and-braces — and this
  // becomes a 500: the client is told the server broke, when in fact it asked for a partial capture the
  // system does not support and never will. Retrying is exactly the wrong response, and a 500 invites it.
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

  // An upstream 500 that nonetheless TAGGED a code (seven filter mappings do) keeps its body. A bodyless
  // 500 would be indistinguishable from a transport failure — the operator loses the one string that
  // says which invariant broke.
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

  // Out of the 400–599 window there is no HTTP error to forward. A `statusCode: 200` on a rejection is
  // nonsense, and answering 200 to a thrown error would be worse than answering 500.
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
  // `details` is how inventory ships `{ available: 3 }` on an `INVENTORY_OUT_OF_STOCK` so the storefront
  // can say "only 3 left" without a second round trip (ADR-030 §6).
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

  // A non-object `details` is DROPPED rather than forwarded, so the body shape stays stable: a client
  // that reads `details.available` must never find a string there. The key is absent entirely — not
  // present-and-undefined, which `toEqual` would let through but a `'details' in body` check would not.
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
  // No `code` means this is not one of our RPC filters talking. The body falls back to Nest's standard
  // `{ statusCode, message, error }` shape, built from the bare message — the status is still honoured,
  // because it is the one thing we do know.
  it('preserves Nest’s default body shape when there is no typed code', () => {
    const thrown = captureThrown(rpcRejection(404, undefined));

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(bodyOf(thrown)).toEqual({
      statusCode: 404,
      message: 'upstream refused',
      error: 'Not Found',
    });
  });

  // **A code-less status outside the four mapped ones is a 500**, and that is the one asymmetry worth
  // knowing about: a bare 422 with no code does NOT reach the client as a 422. It cannot — the generic
  // branch is gated on the code. In practice every filter emits one; this test exists so that if one
  // ever stops, the consequence is written down rather than discovered.
  it('collapses a code-less 422 to a 500 — the generic branch is gated on the code', () => {
    expect(captureThrown(rpcRejection(422, undefined))).toBeInstanceOf(
      InternalServerErrorException,
    );
  });

  // A transport-level rejection (a broker timeout, a dead consumer) has no `statusCode` at all.
  // `Number(undefined)` is `NaN`, and `NaN` matches no branch — so it lands on the bare 500, which is
  // the honest answer: nobody upstream ever refused this, it never arrived.
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

  // A non-string `message` is dropped to `undefined`. Nest then supplies its own default text. Worth
  // pinning because Nest's own ValidationPipe produces `message: string[]` — if an upstream ever
  // forwarded one, the array would vanish silently rather than reach the client as a list of field
  // errors. No filter does today; this records what would happen if one did.
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
