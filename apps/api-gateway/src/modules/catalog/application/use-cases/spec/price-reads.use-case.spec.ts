import { ConflictException, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PriceView } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ICatalogGatewayPort, IPriceQueryCommand, IPriceQueryRequest } from '../../ports';
import { GetApplicablePriceUseCase } from '../get-applicable-price.use-case';
import { ListPricesUseCase } from '../list-prices.use-case';

// The gateway's catalog module had **no unit spec at all** — its use cases were reached only through
// e2e, which exercises the happy path and the currency default and nothing else. Two things go unproven
// that way, and both of them are one-line mistakes with silent consequences:
//
//   1. **The currency resolution (ISSUE-11).** The DTO used to carry `currency = 'USD'` as a literal
//      initializer, so a shop trading in EUR asked catalog for USD prices and got an empty answer for
//      every variant — a 200 with no body, which reads exactly like "this variant has no price". The fix
//      resolves the scope from `CATALOG_GATEWAY_DEFAULT_CURRENCY` **before** the RPC. e2e proves it for
//      the configured currency; nothing proved that an explicit caller-supplied currency still wins.
//
//   2. **The error funnel.** Every RPC-fronting use case in the gateway ends in
//      `catch { logger.error; throwRpcError(error) }`, and that call is what turns a microservice's
//      `{ statusCode, message, code, details }` rejection into the HTTP error a client sees. If it
//      collapsed to a bare 500, every typed error code in the system would stop reaching the client —
//      and every happy-path test would stay green.

const VARIANT_ID = 42;
const CONFIGURED_CURRENCY = 'EUR';
const CORRELATION_ID = 'corr-1';

const priceView = (currency: string): PriceView =>
  ({ id: 1, variantId: VARIANT_ID, currency, amountMinor: 1999 }) as unknown as PriceView;

interface IHarness {
  listPrices: ListPricesUseCase;
  getApplicable: GetApplicablePriceUseCase;
  gateway: {
    listPrices: jest.Mock;
    getApplicablePrice: jest.Mock;
  };
}

const makeHarness = (): IHarness => {
  const gateway = {
    listPrices: jest.fn((command: IPriceQueryCommand) =>
      Promise.resolve([priceView(command.currency)]),
    ),
    getApplicablePrice: jest.fn((command: IPriceQueryCommand) =>
      Promise.resolve(priceView(command.currency)),
    ),
  };
  const logger = makePinoLoggerMock() as unknown as PinoLogger;

  return {
    listPrices: new ListPricesUseCase(
      gateway as unknown as ICatalogGatewayPort,
      CONFIGURED_CURRENCY,
      logger,
    ),
    getApplicable: new GetApplicablePriceUseCase(
      gateway as unknown as ICatalogGatewayPort,
      CONFIGURED_CURRENCY,
      logger,
    ),
    gateway,
  };
};

const request = (overrides: Partial<IPriceQueryRequest> = {}): IPriceQueryRequest =>
  ({ variantId: VARIANT_ID, ...overrides }) as IPriceQueryRequest;

// The shape every microservice `*RpcExceptionFilter` puts on the wire.
const rpcRejection = (
  statusCode: number,
  code: string,
  details?: Record<string, unknown>,
): object =>
  details === undefined
    ? { statusCode, message: 'upstream said no', code }
    : { statusCode, message: 'upstream said no', code, details };

describe('the gateway price reads — currency resolution (ISSUE-11)', () => {
  // **The command carries a currency even when the request did not.** `IPriceQueryRequest.currency` is
  // optional and `IPriceQueryCommand.currency` is not: the two types differ by exactly one `?`, and this
  // use case is the only thing that closes the gap. Sending `undefined` down the wire would let catalog
  // apply its own default — a second, independent answer to the same question.
  it('resolves an absent currency from the configured default before the RPC', async () => {
    const h = makeHarness();

    await h.listPrices.execute(request(), CORRELATION_ID);
    await h.getApplicable.execute(request(), CORRELATION_ID);

    expect(h.gateway.listPrices).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: VARIANT_ID, currency: CONFIGURED_CURRENCY }),
      CORRELATION_ID,
    );
    expect(h.gateway.getApplicablePrice).toHaveBeenCalledWith(
      expect.objectContaining({ variantId: VARIANT_ID, currency: CONFIGURED_CURRENCY }),
      CORRELATION_ID,
    );
  });

  // The other half, and the one e2e cannot see: a caller who NAMES a currency must get that one, not the
  // shop's. `??` and `||` differ here only for the empty string, but a `?? undefined` slip — or a
  // reversed default — would make every explicit currency silently become the shop's.
  it('leaves an explicitly requested currency alone', async () => {
    const h = makeHarness();

    await h.listPrices.execute(request({ currency: 'JPY' }), CORRELATION_ID);
    await h.getApplicable.execute(request({ currency: 'JPY' }), CORRELATION_ID);

    expect(h.gateway.listPrices).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'JPY' }),
      CORRELATION_ID,
    );
    expect(h.gateway.getApplicablePrice).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'JPY' }),
      CORRELATION_ID,
    );
  });

  it('passes the rest of the query through untouched', async () => {
    const h = makeHarness();

    await h.listPrices.execute(request({ asOf: '2026-06-01T00:00:00.000Z' }), CORRELATION_ID);

    expect(h.gateway.listPrices).toHaveBeenCalledWith(
      { variantId: VARIANT_ID, asOf: '2026-06-01T00:00:00.000Z', currency: CONFIGURED_CURRENCY },
      CORRELATION_ID,
    );
  });
});

describe('the gateway price reads — the RPC error funnel', () => {
  // `throwRpcError` forwards the upstream `statusCode` and the typed `code`, so a client can branch on a
  // stable string instead of matching a human-readable message. A funnel that dropped the code would not
  // fail anything — the status would still be right — and every client's error handling would quietly
  // fall back to "something went wrong".
  it('forwards an upstream 404 with its typed code intact', async () => {
    const h = makeHarness();
    h.gateway.getApplicablePrice.mockRejectedValueOnce(
      rpcRejection(404, 'CATALOG_VARIANT_NOT_FOUND'),
    );

    // One call, one rejection: `mockRejectedValueOnce` arms exactly one, and a second `execute` would
    // sail through the happy path and resolve.
    const thrown = await h.getApplicable
      .execute(request(), CORRELATION_ID)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).toMatchObject({
      status: 404,
      response: { statusCode: 404, code: 'CATALOG_VARIANT_NOT_FOUND' },
    });
  });

  // A structured `details` payload rides along when the upstream supplied one — it is how a storefront
  // shows "only 3 left" without a second round trip. Dropping it is invisible to a status-code assertion.
  it('forwards a structured details payload alongside the code', async () => {
    const h = makeHarness();
    h.gateway.listPrices.mockRejectedValueOnce(
      rpcRejection(409, 'CATALOG_PRICE_OVERLAP', { conflictingPriceId: 7 }),
    );

    await expect(h.listPrices.execute(request(), CORRELATION_ID)).rejects.toMatchObject({
      status: 409,
      response: { code: 'CATALOG_PRICE_OVERLAP', details: { conflictingPriceId: 7 } },
    });
  });

  it('maps an upstream conflict to a ConflictException rather than a 500', async () => {
    const h = makeHarness();
    h.gateway.listPrices.mockRejectedValueOnce(rpcRejection(409, 'CATALOG_PRICE_OVERLAP'));

    await expect(h.listPrices.execute(request(), CORRELATION_ID)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  // A transport-level failure carries no `statusCode` and no `code` — there is nothing to forward, and
  // inventing a 4xx would tell the client its request was at fault when the broker was. 500 is correct
  // here, and it is the ONLY case in which 500 is correct.
  it('falls back to a 500 for a rejection that carries no RPC shape at all', async () => {
    const h = makeHarness();
    h.gateway.listPrices.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(h.listPrices.execute(request(), CORRELATION_ID)).rejects.toMatchObject({
      status: 500,
    });
  });
});
