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

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    publisher = new InMemoryCartEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new CreateCartUseCase(repository, publisher, logger as unknown as PinoLogger);
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

  it('defaults the currency to USD when omitted', async () => {
    const view = await useCase.execute({ customerId: CUSTOMER_ID, correlationId: 'corr-2' });

    expect(view.currency).toBe('USD');
  });
});
