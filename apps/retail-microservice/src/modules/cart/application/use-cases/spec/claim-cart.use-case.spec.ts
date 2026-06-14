import { PinoLogger } from 'nestjs-pino';

import { CartStatusEnum } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { Cart, CartErrorCodeEnum } from '../../../domain';
import { ClaimCartUseCase } from '../claim-cart.use-case';
import { InMemoryCartInventoryGateway, InMemoryCartRepository } from './test-doubles';

const CART_ID = '11111111-1111-4111-8111-111111111111';
const GUEST_ID = '00000000-0000-4000-a000-0000000000aa';
const REGISTERED_ID = '00000000-0000-4000-a000-000000000002';

describe('ClaimCartUseCase', () => {
  let repository: InMemoryCartRepository;
  // The claim use case takes NO inventory gateway: reservations key on `cartId`,
  // which a claim re-points the owner of but never changes, so the holds survive
  // untouched. The fake is constructed only to assert it is never called.
  let inventory: InMemoryCartInventoryGateway;
  let logger: PinoLoggerMock;
  let useCase: ClaimCartUseCase;

  beforeEach(() => {
    repository = new InMemoryCartRepository();
    inventory = new InMemoryCartInventoryGateway();
    logger = makePinoLoggerMock();
    useCase = new ClaimCartUseCase(repository, logger as unknown as PinoLogger);

    repository.seed(
      Cart.reconstitute({
        id: CART_ID,
        customerId: GUEST_ID,
        currency: 'USD',
        status: CartStatusEnum.ACTIVE,
        lines: [],
        version: 1,
      }),
    );
  });

  it('re-points the cart only when cart.customerId === fromCustomerId, with no inventory call', async () => {
    const view = await useCase.execute({
      cartId: CART_ID,
      fromCustomerId: GUEST_ID,
      newCustomerId: REGISTERED_ID,
      correlationId: 'corr-1',
    });

    expect(view.id).toBe(CART_ID);
    expect(view.customerId).toBe(REGISTERED_ID);

    // The repository now resolves the cart to the registered owner.
    const reloaded = await repository.findById(CART_ID);
    expect(reloaded?.customerId).toBe(REGISTERED_ID);

    // The claim re-points ownership but touches no reservation (holds key on cartId).
    expect(inventory.reserveCalls).toHaveLength(0);
    expect(inventory.releaseCalls).toHaveLength(0);
  });

  it('rejects when the fromCustomerId proof does not match the cart owner', async () => {
    await expect(
      useCase.execute({
        cartId: CART_ID,
        fromCustomerId: '00000000-0000-4000-a000-0000000000bb',
        newCustomerId: REGISTERED_ID,
        correlationId: 'corr-2',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_ACCESS_FORBIDDEN });

    // Owner is unchanged.
    const reloaded = await repository.findById(CART_ID);
    expect(reloaded?.customerId).toBe(GUEST_ID);
  });

  it('rejects an unknown cart with CART_NOT_FOUND', async () => {
    await expect(
      useCase.execute({
        cartId: '99999999-9999-4999-8999-999999999999',
        fromCustomerId: GUEST_ID,
        newCustomerId: REGISTERED_ID,
        correlationId: 'corr-3',
      }),
    ).rejects.toMatchObject({ code: CartErrorCodeEnum.CART_NOT_FOUND });
  });
});
