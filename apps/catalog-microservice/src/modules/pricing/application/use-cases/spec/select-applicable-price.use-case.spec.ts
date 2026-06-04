import { PinoLogger } from 'nestjs-pino';

import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Price } from '../../../domain';
import { SelectApplicablePriceUseCase } from '../select-applicable-price.use-case';
import { InMemoryPricingRepository } from './test-doubles';

// The resolution policy (priority DESC, then validFrom DESC) lives in the use
// case, not in SQL — these specs prove it against an in-memory repository whose
// `findInEffect` returns candidates **unsorted** (insertion order). If the
// resolution had leaked into the query, an unsorted candidate set would surface
// the bug here.
describe('SelectApplicablePriceUseCase', () => {
  const VARIANT_ID = 42;
  const CURRENCY = 'USD';

  let repository: InMemoryPricingRepository;
  let logger: PinoLoggerMock;
  let useCase: SelectApplicablePriceUseCase;

  beforeEach(() => {
    repository = new InMemoryPricingRepository();
    logger = makePinoLoggerMock();
    useCase = new SelectApplicablePriceUseCase(repository, logger as unknown as PinoLogger);
  });

  const seedPrice = (
    id: number,
    amountMinor: number,
    validFrom: string,
    validTo: string | null,
    priority: number,
  ): void => {
    repository.seed(
      Price.reconstitute({
        id,
        variantId: VARIANT_ID,
        currency: CURRENCY,
        amountMinor,
        validFrom: new Date(validFrom),
        validTo: validTo === null ? null : new Date(validTo),
        priority,
      }),
    );
  };

  it('resolves the highest-priority row when several are in effect', async () => {
    seedPrice(1, 1000, '2020-01-01T00:00:00.000Z', null, 0); // base, open
    seedPrice(2, 800, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 10); // promo

    const view = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2026-06-01T00:00:00.000Z',
      correlationId: 'corr-1',
    });

    expect(view?.amountMinor).toBe(800);
    expect(view?.priority).toBe(10);
  });

  it('breaks ties by the latest validFrom', async () => {
    seedPrice(3, 700, '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 5);
    seedPrice(4, 650, '2026-03-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 5);

    const view = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2026-06-01T00:00:00.000Z',
      correlationId: 'corr-1',
    });

    // Same priority → the more recently started interval wins.
    expect(view?.amountMinor).toBe(650);
  });

  it('respects asOf interval containment (half-open: validTo is exclusive)', async () => {
    seedPrice(5, 1000, '2020-01-01T00:00:00.000Z', null, 0); // base, open
    seedPrice(6, 800, '2026-01-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', 10); // promo ends

    // At exactly the promo's validTo the promo is already out (exclusive end), so
    // the base resolves despite the promo's higher priority.
    const atBoundary = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2026-06-01T00:00:00.000Z',
      correlationId: 'corr-1',
    });
    expect(atBoundary?.amountMinor).toBe(1000);

    // Well after the promo: still the base.
    const after = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2026-09-01T00:00:00.000Z',
      correlationId: 'corr-1',
    });
    expect(after?.amountMinor).toBe(1000);
  });

  it('returns null when no row is in scope at asOf', async () => {
    seedPrice(7, 1000, '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', 0);

    const view = await useCase.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2025-01-01T00:00:00.000Z', // before any interval
      correlationId: 'corr-1',
    });

    expect(view).toBeNull();
  });

  it('returns null for a scope with no rows at all', async () => {
    const view = await useCase.execute({
      variantId: 999,
      currency: CURRENCY,
      correlationId: 'corr-1',
    });

    expect(view).toBeNull();
  });
});
