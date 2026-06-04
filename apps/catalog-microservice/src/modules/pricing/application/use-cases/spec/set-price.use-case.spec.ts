import { PinoLogger } from 'nestjs-pino';

import { IPriceSetPayload } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Price, PricingDomainException, PricingErrorCodeEnum } from '../../../domain';
import { SetPriceUseCase } from '../set-price.use-case';
import { InMemoryPricingEventsPublisher, InMemoryPricingRepository } from './test-doubles';

describe('SetPriceUseCase (immediate Set)', () => {
  const VARIANT_ID = 42;
  const CURRENCY = 'USD';

  let repository: InMemoryPricingRepository;
  let publisher: InMemoryPricingEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: SetPriceUseCase;

  beforeEach(() => {
    repository = new InMemoryPricingRepository();
    publisher = new InMemoryPricingEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new SetPriceUseCase(repository, publisher, logger as unknown as PinoLogger);
  });

  // No `validFrom` → the domain defaults it to "now" → an immediate price.
  const immediatePayload: IPriceSetPayload = {
    variantId: VARIANT_ID,
    currency: CURRENCY,
    amountMinor: 1999,
    priority: 0,
    correlationId: 'corr-1',
  };

  it('opens a new price for an empty scope and emits catalog.price.changed', async () => {
    const view = await useCase.execute(immediatePayload);

    expect(view.id).toEqual(expect.any(Number));
    expect(view.variantId).toBe(VARIANT_ID);
    expect(view.currency).toBe(CURRENCY);
    expect(view.amountMinor).toBe(1999);
    expect(view.validTo).toBeNull();
    expect(view.priority).toBe(0);

    // First price for the scope — nothing was closed, exactly one row appended.
    expect(repository.appended).toHaveLength(1);

    // An immediate price emits `changed`, never `scheduled`.
    expect(publisher.changed).toHaveLength(1);
    expect(publisher.scheduled).toHaveLength(0);
    const [{ event, correlationId }] = publisher.changed;
    expect(event.variantId).toBe(VARIANT_ID);
    expect(event.currency).toBe(CURRENCY);
    expect(event.amountMinor).toBe(1999);
    expect(event.validTo).toBeNull();
    expect(event.priority).toBe(0);
    expect(event.eventVersion).toBe('v1');
    expect(event.validFrom).toBe(view.validFrom);
    expect(typeof event.occurredAt).toBe('string');
    expect(event.correlationId).toBe('corr-1');
    expect(correlationId).toBe('corr-1');

    // The new row is the open row for the scope now.
    const open = await repository.findOpenPrice(VARIANT_ID, CURRENCY);
    expect(open?.amountMinor).toBe(1999);
  });

  it('closes an existing open predecessor at the new validFrom', async () => {
    const pastValidFrom = new Date('2020-01-01T00:00:00.000Z');
    repository.seed(
      Price.reconstitute({
        id: 7,
        variantId: VARIANT_ID,
        currency: CURRENCY,
        amountMinor: 1500,
        validFrom: pastValidFrom,
        validTo: null,
        priority: 0,
      }),
    );

    const view = await useCase.execute({ ...immediatePayload, amountMinor: 1999 });

    // The successor is the open row; the predecessor is closed at exactly the
    // successor's validFrom (half-open intervals tile without overlap).
    const open = await repository.findOpenPrice(VARIANT_ID, CURRENCY);
    expect(open?.amountMinor).toBe(1999);

    const [predecessor] = await repository.findInEffect(
      VARIANT_ID,
      CURRENCY,
      new Date('2020-06-01T00:00:00.000Z'),
    );
    expect(predecessor.amountMinor).toBe(1500);
    expect(predecessor.validTo).not.toBeNull();
    expect(predecessor.validTo?.toISOString()).toBe(view.validFrom);

    expect(publisher.changed).toHaveLength(1);
  });

  it('rejects with PRICE_SCHEDULE_CONFLICT when an open row starts at/after the new row', async () => {
    // An open row scheduled in the far future already exists; an immediate price
    // (validFrom = now) would start before it, which has no reschedule flow.
    repository.seed(
      Price.reconstitute({
        id: 9,
        variantId: VARIANT_ID,
        currency: CURRENCY,
        amountMinor: 1500,
        validFrom: new Date('2099-01-01T00:00:00.000Z'),
        validTo: null,
        priority: 0,
      }),
    );

    await expect(useCase.execute(immediatePayload)).rejects.toMatchObject({
      code: PricingErrorCodeEnum.PRICE_SCHEDULE_CONFLICT,
    });
    await expect(useCase.execute(immediatePayload)).rejects.toBeInstanceOf(PricingDomainException);

    // Nothing appended, nothing emitted.
    expect(repository.appended).toHaveLength(0);
    expect(publisher.changed).toHaveLength(0);
    expect(publisher.scheduled).toHaveLength(0);
  });

  it('still returns the view when the publish rejects (best-effort post-commit)', async () => {
    publisher.publishPriceChanged = (): Promise<void> => Promise.reject(new Error('rmq-down'));

    const view = await useCase.execute(immediatePayload);

    expect(view.amountMinor).toBe(1999);
    expect(repository.appended).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'corr-1', variantId: VARIANT_ID }),
      'Failed to publish catalog.price.changed event',
    );
  });
});
