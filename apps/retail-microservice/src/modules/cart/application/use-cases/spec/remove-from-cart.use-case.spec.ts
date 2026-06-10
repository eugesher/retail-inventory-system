import { PinoLogger } from 'nestjs-pino';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Cart, CartErrorCodeEnum, CartLine } from '../../../domain';
import { RemoveFromCartUseCase } from '../remove-from-cart.use-case';
import { InMemoryCartEventsPublisher, InMemoryCartRepository } from './test-doubles';

const CART_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const LINE_ID = 5000;
const OTHER_LINE_ID = 5001;

const seedCartWithTwoLines = (repository: InMemoryCartRepository): void => {
  repository.seed(
    Cart.reconstitute({
      id: CART_ID,
      customerId: OWNER_ID,
      currency: 'USD',
      status: CartStatusEnum.ACTIVE,
      lines: [
        new CartLine({
          id: LINE_ID,
          variantId: 1,
          quantity: 2,
          unitPriceSnapshotMinor: 4999,
          currencySnapshot: 'USD',
        }),
        new CartLine({
          id: OTHER_LINE_ID,
          variantId: 2,
          quantity: 1,
          unitPriceSnapshotMinor: 1999,
          currencySnapshot: 'USD',
        }),
      ],
      version: 2,
    }),
  );
};

describe('RemoveFromCartUseCase', () => {
  let repository: InMemoryCartRepository;
  let publisher: InMemoryCartEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: RemoveFromCartUseCase;

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    publisher = new InMemoryCartEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new RemoveFromCartUseCase(repository, publisher, logger as unknown as PinoLogger);
    seedCartWithTwoLines(repository);
  });

  it('drops the right line and emits retail.cart.line-removed', async () => {
    const view = await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      lineId: LINE_ID,
      correlationId: 'corr-1',
    });

    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].id).toBe(OTHER_LINE_ID);

    expect(publisher.lineRemoved).toHaveLength(1);
    const [{ event }] = publisher.lineRemoved;
    expect(event.cartId).toBe(CART_ID);
    expect(event.lineId).toBe(LINE_ID);
    expect(event.eventVersion).toBe('v1');
  });

  it('rejects removing an unknown line with CART_LINE_NOT_FOUND', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        lineId: 999999,
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_LINE_NOT_FOUND });

    expect(publisher.lineRemoved).toHaveLength(0);
  });

  it('rejects a non-owner with CART_ACCESS_FORBIDDEN', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OTHER_ID,
        lineId: LINE_ID,
        correlationId: 'corr-3',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_ACCESS_FORBIDDEN });
  });
});
