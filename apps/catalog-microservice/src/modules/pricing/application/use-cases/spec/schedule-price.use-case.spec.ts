import { PinoLogger } from 'nestjs-pino';

import { IPriceSetPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Price } from '../../../domain';
import { SelectApplicablePriceUseCase } from '../select-applicable-price.use-case';
import { SetPriceUseCase } from '../set-price.use-case';
import { InMemoryPricingEventsPublisher, InMemoryPricingRepository } from './test-doubles';

// Schedule is the same `SetPriceUseCase` with a future `validFrom`. These specs
// run Set and Select against the *same* repository so the scheduling guarantee
// (the current answer is unchanged until `validFrom`) is exercised end-to-end.
describe('SetPriceUseCase (Schedule — future validFrom)', () => {
  const VARIANT_ID = 42;
  const CURRENCY = 'USD';
  const FUTURE = '2099-06-01T00:00:00.000Z';

  let repository: InMemoryPricingRepository;
  let publisher: InMemoryPricingEventsPublisher;
  let logger: PinoLoggerMock;
  let setPrice: SetPriceUseCase;
  let selectPrice: SelectApplicablePriceUseCase;

  beforeEach(() => {
    repository = new InMemoryPricingRepository();
    publisher = new InMemoryPricingEventsPublisher();
    logger = makePinoLoggerMock();
    setPrice = new SetPriceUseCase(repository, publisher, logger as unknown as PinoLogger);
    selectPrice = new SelectApplicablePriceUseCase(repository, logger as unknown as PinoLogger);

    // An existing, currently-in-effect open price (the "current" answer).
    repository.seed(
      Price.reconstitute({
        id: 1,
        variantId: VARIANT_ID,
        currency: CURRENCY,
        amountMinor: 1500,
        validFrom: new Date('2020-01-01T00:00:00.000Z'),
        validTo: null,
        priority: 0,
      }),
    );
  });

  const schedulePayload: IPriceSetPayload = {
    variantId: VARIANT_ID,
    currency: CURRENCY,
    amountMinor: 2500,
    validFrom: FUTURE,
    correlationId: 'corr-sched',
  };

  it('emits catalog.price.scheduled with effectiveAt == validFrom', async () => {
    const view = await setPrice.execute(schedulePayload);

    expect(view.validFrom).toBe(FUTURE);
    expect(view.amountMinor).toBe(2500);

    expect(publisher.scheduled).toHaveLength(1);
    expect(publisher.changed).toHaveLength(0);
    const [{ event, correlationId }] = publisher.scheduled;
    expect(event.effectiveAt).toBe(FUTURE);
    expect(event.validFrom).toBe(FUTURE);
    expect(event.amountMinor).toBe(2500);
    expect(event.eventVersion).toBe('v1');
    expect(correlationId).toBe('corr-sched');
  });

  it('closes the predecessor exactly at the future validFrom', async () => {
    await setPrice.execute(schedulePayload);

    // At a point before the changeover the predecessor is still in effect and now
    // carries a concrete validTo equal to the scheduled validFrom.
    const [predecessor] = await repository.findInEffect(
      VARIANT_ID,
      CURRENCY,
      new Date('2030-01-01T00:00:00.000Z'),
    );
    expect(predecessor.amountMinor).toBe(1500);
    expect(predecessor.validTo?.toISOString()).toBe(FUTURE);
  });

  it('leaves the current answer unchanged until validFrom, then switches', async () => {
    await setPrice.execute(schedulePayload);

    // Before the changeover: the current price still resolves.
    const before = await selectPrice.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2030-01-01T00:00:00.000Z',
      correlationId: 'corr-sel',
    });
    expect(before?.amountMinor).toBe(1500);

    // After the changeover: the scheduled price resolves.
    const after = await selectPrice.execute({
      variantId: VARIANT_ID,
      currency: CURRENCY,
      asOf: '2099-12-01T00:00:00.000Z',
      correlationId: 'corr-sel',
    });
    expect(after?.amountMinor).toBe(2500);
  });
});
