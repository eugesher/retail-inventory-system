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

  // The default currency is now INJECTED (`RETAIL_DEFAULT_CURRENCY` ← `DEFAULT_CURRENCY`),
  // so the spec can bind it. It used to be a file-local literal, which is why the
  // "opens in EUR when the server is configured for EUR" test below could not even be
  // written — there was nothing to bind.
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

  // THE defect this token exists to close. Catalog resolves the same concept from
  // `DEFAULT_CURRENCY`; the cart used to resolve it from a file-local `'USD'`. An operator
  // who set `DEFAULT_CURRENCY=EUR` therefore got a catalog quoting EUR and carts still
  // opening in USD — and `Cart.currency` is immutable (ADR-028 §1), so the wrong unit was
  // snapshotted into the order and the payment with nothing downstream able to tell.
  it('opens the cart in the CONFIGURED currency when the caller names none', async () => {
    const view = await withDefaultCurrency('EUR').execute({
      customerId: CUSTOMER_ID,
      correlationId: 'corr-3',
    });

    expect(view.currency).toBe('EUR');
    // The emitted event carries it too — a consumer must not be told 'USD' either.
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
