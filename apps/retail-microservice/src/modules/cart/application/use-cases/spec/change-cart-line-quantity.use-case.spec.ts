import { PinoLogger } from 'nestjs-pino';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Cart, CartErrorCodeEnum, CartLine } from '../../../domain';
import { ChangeCartLineQuantityUseCase } from '../change-cart-line-quantity.use-case';
import { InMemoryCartEventsPublisher, InMemoryCartRepository } from './test-doubles';

const CART_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';
const LINE_ID = 5000;

const seedCartWithLine = (repository: InMemoryCartRepository): void => {
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
          quantity: 3,
          unitPriceSnapshotMinor: 4999,
          currencySnapshot: 'USD',
        }),
      ],
      version: 1,
    }),
  );
};

describe('ChangeCartLineQuantityUseCase', () => {
  let repository: InMemoryCartRepository;
  let publisher: InMemoryCartEventsPublisher;
  let logger: PinoLoggerMock;
  let useCase: ChangeCartLineQuantityUseCase;

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    publisher = new InMemoryCartEventsPublisher();
    logger = makePinoLoggerMock();
    useCase = new ChangeCartLineQuantityUseCase(
      repository,
      publisher,
      logger as unknown as PinoLogger,
    );
    seedCartWithLine(repository);
  });

  it('sets the line quantity and emits retail.cart.line-quantity-changed', async () => {
    const view = await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      lineId: LINE_ID,
      quantity: 1,
      correlationId: 'corr-1',
    });

    expect(view.lines).toHaveLength(1);
    expect(view.lines[0].quantity).toBe(1);
    expect(view.subtotalMinor).toBe(4999);

    expect(publisher.lineQuantityChanged).toHaveLength(1);
    const [{ event }] = publisher.lineQuantityChanged;
    expect(event.cartId).toBe(CART_ID);
    expect(event.lineId).toBe(LINE_ID);
    expect(event.quantity).toBe(1);
    expect(event.eventVersion).toBe('v1');
  });

  it('rejects quantity 0 (removal is the explicit op)', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OWNER_ID,
        lineId: LINE_ID,
        quantity: 0,
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_LINE_QUANTITY_INVALID });

    expect(publisher.lineQuantityChanged).toHaveLength(0);
  });

  it('rejects a non-owner with CART_ACCESS_FORBIDDEN', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        customerId: OTHER_ID,
        lineId: LINE_ID,
        quantity: 1,
        correlationId: 'corr-3',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_ACCESS_FORBIDDEN });
  });
});
