import { PinoLogger } from 'nestjs-pino';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Cart, CartErrorCodeEnum, CartLine } from '../../../domain';
import { GetCartUseCase } from '../get-cart.use-case';
import { InMemoryCartRepository } from './test-doubles';

const CART_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '00000000-0000-4000-a000-000000000002';
const OTHER_ID = '00000000-0000-4000-a000-000000000099';

describe('GetCartUseCase', () => {
  let repository: InMemoryCartRepository;
  let logger: PinoLoggerMock;
  let useCase: GetCartUseCase;

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    logger = makePinoLoggerMock();
    useCase = new GetCartUseCase(repository, logger as unknown as PinoLogger);

    repository.seed(
      Cart.reconstitute({
        id: CART_ID,
        customerId: OWNER_ID,
        currency: 'USD',
        status: CartStatusEnum.ACTIVE,
        lines: [
          new CartLine({
            id: 5000,
            variantId: 1,
            quantity: 2,
            unitPriceSnapshotMinor: 4999,
            currencySnapshot: 'USD',
          }),
        ],
        version: 1,
      }),
    );
  });

  it('returns the cart view for the owner', async () => {
    const view = await useCase.execute({
      cartId: CART_ID,
      customerId: OWNER_ID,
      correlationId: 'corr-1',
    });

    expect(view.id).toBe(CART_ID);
    expect(view.customerId).toBe(OWNER_ID);
    expect(view.lines).toHaveLength(1);
    expect(view.subtotalMinor).toBe(9998);
  });

  it('rejects an unknown cart with CART_NOT_FOUND (404)', async () => {
    await expect(
      useCase.execute({
        cartId: '99999999-9999-4999-8999-999999999999',
        customerId: OWNER_ID,
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_NOT_FOUND });
  });

  it('rejects a non-owner with CART_ACCESS_FORBIDDEN (403)', async () => {
    await expect(
      useCase.execute({ cartId: CART_ID, customerId: OTHER_ID, correlationId: 'corr-3' }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_ACCESS_FORBIDDEN });
  });
});
