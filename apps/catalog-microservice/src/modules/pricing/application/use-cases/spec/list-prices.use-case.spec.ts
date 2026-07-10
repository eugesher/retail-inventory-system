import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Price } from '../../../domain';
import { ListPricesUseCase } from '../list-prices.use-case';
import { InMemoryPricingRepository } from './test-doubles';

const VARIANT_ID = 100;
const CURRENCY = 'EUR';

// Every bound is pinned to UTC (`Z`): a zone-less ISO string resolves in the Node host's
// local zone, which would make the interval-containment assertions machine-dependent.
const seedPrice = (
  repository: InMemoryPricingRepository,
  input: {
    id: number;
    amountMinor: number;
    validFrom: string;
    validTo?: string | null;
    priority?: number;
    variantId?: number;
    currency?: string;
  },
): Price => {
  const price = Price.reconstitute({
    id: input.id,
    variantId: input.variantId ?? VARIANT_ID,
    currency: input.currency ?? CURRENCY,
    amountMinor: input.amountMinor,
    validFrom: new Date(input.validFrom),
    validTo: input.validTo ? new Date(input.validTo) : null,
    priority: input.priority ?? 0,
  });
  repository.seed(price);
  return price;
};

describe('ListPricesUseCase', () => {
  let repository: InMemoryPricingRepository;
  let logger: PinoLoggerMock;
  let useCase: ListPricesUseCase;

  beforeEach(() => {
    repository = new InMemoryPricingRepository();
    logger = makePinoLoggerMock();
    useCase = new ListPricesUseCase(repository, logger as unknown as PinoLogger);
  });

  it('returns an empty array when the variant has no price in effect', async () => {
    const views = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      correlationId: 'corr-1',
    });

    expect(views).toEqual([]);
  });

  it('maps every in-effect row onto its view, dates as ISO-8601 and an open row’s validTo null', async () => {
    seedPrice(repository, { id: 1, amountMinor: 1999, validFrom: '2026-01-01T00:00:00Z' });

    const views = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2026-06-01T00:00:00Z',
      correlationId: 'corr-1',
    });

    expect(views).toEqual([
      {
        id: 1,
        variantId: VARIANT_ID,
        currency: CURRENCY,
        amountMinor: 1999,
        validFrom: '2026-01-01T00:00:00.000Z',
        validTo: null,
        priority: 0,
      },
    ]);
  });

  // The whole point of List (vs Select): it surfaces the entire candidate set, overlapping
  // priorities included, so an operator can see what resolution is choosing between.
  it('surfaces the whole overlapping candidate set rather than collapsing to one answer', async () => {
    seedPrice(repository, { id: 1, amountMinor: 1999, validFrom: '2026-01-01T00:00:00Z' });
    seedPrice(repository, {
      id: 2,
      amountMinor: 1499,
      validFrom: '2026-05-01T00:00:00Z',
      validTo: '2026-07-01T00:00:00Z',
      priority: 10,
    });

    const views = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2026-06-01T00:00:00Z',
      correlationId: 'corr-1',
    });

    expect(views).toHaveLength(2);
    expect(views.map((view) => view.amountMinor).sort()).toEqual([1499, 1999]);
  });

  it('excludes a row not yet in effect and one already closed at asOf', async () => {
    const inEffect = seedPrice(repository, {
      id: 1,
      amountMinor: 1999,
      validFrom: '2026-01-01T00:00:00Z',
    });
    // Closed before asOf — validTo is exclusive.
    seedPrice(repository, {
      id: 2,
      amountMinor: 900,
      validFrom: '2025-01-01T00:00:00Z',
      validTo: '2026-06-01T00:00:00Z',
    });
    // Scheduled after asOf.
    seedPrice(repository, { id: 3, amountMinor: 2500, validFrom: '2026-09-01T00:00:00Z' });

    const views = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2026-06-01T00:00:00Z',
      correlationId: 'corr-1',
    });

    expect(views.map((view) => view.id)).toEqual([inEffect.id]);
  });

  it('scopes the list to the requested (variantId, currency) pair', async () => {
    const wanted = seedPrice(repository, {
      id: 1,
      amountMinor: 1999,
      validFrom: '2026-01-01T00:00:00Z',
    });
    seedPrice(repository, {
      id: 2,
      amountMinor: 1799,
      validFrom: '2026-01-01T00:00:00Z',
      currency: 'USD',
    });
    seedPrice(repository, {
      id: 3,
      amountMinor: 1899,
      validFrom: '2026-01-01T00:00:00Z',
      variantId: 999,
    });

    const views = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2026-06-01T00:00:00Z',
      correlationId: 'corr-1',
    });

    expect(views.map((view) => view.id)).toEqual([wanted.id]);
  });

  // `asOf` defaulting is a gateway-DTO concern; here an absent `asOf` falls back to now,
  // so a currently-open row is in effect and a future-dated one is not.
  it('falls back to now when asOf is absent', async () => {
    const open = seedPrice(repository, {
      id: 1,
      amountMinor: 1999,
      validFrom: '2020-01-01T00:00:00Z',
    });
    seedPrice(repository, { id: 2, amountMinor: 2500, validFrom: '2999-01-01T00:00:00Z' });

    const views = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      correlationId: 'corr-1',
    });

    expect(views.map((view) => view.id)).toEqual([open.id]);
  });
});
