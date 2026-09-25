import { PinoLogger } from 'nestjs-pino';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { CreateCartUseCase } from '../create-cart.use-case';
import { InMemoryCartEventsPublisher, InMemoryCartRepository } from './test-doubles';

const CUSTOMER_ID = '00000000-0000-4000-a000-000000000002';

describe('CreateCartUseCase', () => {
  let repository: InMemoryCartRepository;
  let publisher: InMemoryCartEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: CreateCartUseCase;

  const withDefaultCurrency = (defaultCurrency: string): CreateCartUseCase =>
    new CreateCartUseCase(repository, publisher, defaultCurrency, logger as unknown as PinoLogger);

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    publisher = new InMemoryCartEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = withDefaultCurrency('USD');
  });

  it('opens an active cart for the caller and emits retail.cart.created', async () => {
    const view = await useCase.execute({
      customerId: CUSTOMER_ID,
      currency: 'EUR',
      correlationId: 'corr-1',
    });

    expect(view.id).toEqual(expect.any(String));
    expect(view.customerId).toBe(CUSTOMER_ID);
    expect(view.currency).toBe('EUR');
    expect(view.status).toBe(CartStatusEnum.ACTIVE);
    expect(view.lines).toEqual([]);
    expect(view.subtotalMinor).toBe(0);

    expect(publisher.created).toHaveLength(1);
    const [{ event }] = publisher.created;
    expect(event.cartId).toBe(view.id);
    expect(event.customerId).toBe(CUSTOMER_ID);
    expect(event.currency).toBe('EUR');
    expect(event.eventVersion).toBe('v1');
    expect(event.correlationId).toBe('corr-1');
  });

  it('defaults the currency to USD when omitted (the shipped configuration)', async () => {
    const view = await useCase.execute({ customerId: CUSTOMER_ID, correlationId: 'corr-2' });

    expect(view.currency).toBe('USD');
  });

  it('opens the cart in the CONFIGURED currency when the caller names none', async () => {
    const view = await withDefaultCurrency('EUR').execute({
      customerId: CUSTOMER_ID,
      correlationId: 'corr-3',
    });

    expect(view.currency).toBe('EUR');
    expect(publisher.created).toHaveLength(1);
    expect(publisher.created[0].event.currency).toBe('EUR');
  });

  it('an explicit currency still wins over the configured default', async () => {
    const view = await withDefaultCurrency('EUR').execute({
      customerId: CUSTOMER_ID,
      currency: 'GBP',
      correlationId: 'corr-4',
    });

    expect(view.currency).toBe('GBP');
  });
});
