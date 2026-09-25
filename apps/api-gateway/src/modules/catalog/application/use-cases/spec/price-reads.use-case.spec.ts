import { ConflictException, NotFoundException } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

import { PriceView } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { ICatalogGatewayPort, IPriceQueryCommand, IPriceQueryRequest } from '../../ports';
import { GetApplicablePriceUseCase } from '../get-applicable-price.use-case';
import { ListPricesUseCase } from '../list-prices.use-case';

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

const rpcRejection = (
  statusCode: number,
  code: string,
  details?: Record<string, unknown>,
): object =>
  details === undefined
    ? { statusCode, message: 'upstream said no', code }
    : { statusCode, message: 'upstream said no', code, details };

describe('the gateway price reads — currency resolution (ISSUE-11)', () => {
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
  it('forwards an upstream 404 with its typed code intact', async () => {
    const h = makeHarness();
    h.gateway.getApplicablePrice.mockRejectedValueOnce(
      rpcRejection(404, 'CATALOG_VARIANT_NOT_FOUND'),
    );

    const thrown = await h.getApplicable
      .execute(request(), CORRELATION_ID)
      .catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(NotFoundException);
    expect(thrown).toMatchObject({
      status: 404,
      response: { statusCode: 404, code: 'CATALOG_VARIANT_NOT_FOUND' },
    });
  });

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

  it('falls back to a 500 for a rejection that carries no RPC shape at all', async () => {
    const h = makeHarness();
    h.gateway.listPrices.mockRejectedValueOnce(new Error('ECONNRESET'));

    await expect(h.listPrices.execute(request(), CORRELATION_ID)).rejects.toMatchObject({
      status: 500,
    });
  });
});
